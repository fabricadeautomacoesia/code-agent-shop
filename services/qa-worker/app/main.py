"""
QA Worker - Code & Agent Shop
Pipeline: download pacote -> analise estatica -> LLM scoring -> callback qa-svc.

Fallback LLM: OpenAI -> Gemini -> Groq (V8 23.7).
Confidence threshold APLICADO em qa-svc (callback handler), nao aqui.
qa-worker envia o score literal LLM (0.0-1.0) - decisao approved/rejected
fica com qa-svc lendo QA_CONFIDENCE_THRESHOLD env (default 0.80).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Optional

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel, Field

# Caminho do .env raiz
ENV_PATH = Path(__file__).resolve().parent.parent.parent.parent / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

OPENAI_KEY = os.getenv("OPENAI_API_KEY")
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GROQ_KEY = os.getenv("GROQ_API_KEY")
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT_MS", "60000")) / 1000
# FIX-WORKER-12 pass 192: per-provider budget para fallback chain.
# Pre-fix: LLM_TIMEOUT 60s era POR PROVIDER -> chain de 3 providers podia
# tomar 180s. Caller qa-svc (cron timeout 5min) consumido demais por chain
# antes de retornar verdict.
# Post-fix: LLM_PROVIDER_TIMEOUT (default 20s) por provider individual.
# Budget total chain: 60s. Mesmo orcamento que pre-fix mas predictable.
LLM_PROVIDER_TIMEOUT = int(os.getenv("LLM_PROVIDER_TIMEOUT_MS", "20000")) / 1000

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

MAX_PKG_BYTES = int(os.getenv("QA_MAX_FILE_SIZE_MB", "50")) * 1024 * 1024

app = FastAPI(title="cas-qa-worker", version="0.1.0")


# ============================================================
# Schemas
# ============================================================
class AnalyzeRequest(BaseModel):
    run_id: str
    product_id: str
    product_version_id: Optional[str] = None
    title: str
    description: str
    kind: str
    package_url: Optional[str] = None
    package_hash_sha256: Optional[str] = None
    tech_stack: Optional[list[str]] = None
    api_keys_required: Optional[list[str]] = None
    install_instructions: Optional[str] = None
    callback_url: str


class ScoreOutput(BaseModel):
    confidence_score: float = Field(ge=0.0, le=1.0)
    sintaxe_ok: bool
    resolves_problem: bool
    is_functional: bool
    reasons: list[str] = []
    suggestions: list[str] = []


# ============================================================
# Health
# ============================================================
@app.get("/health")
def health():
    return {
        "ok": True,
        "svc": "qa-worker",
        "providers": {
            "openai": bool(OPENAI_KEY),
            "gemini": bool(GEMINI_KEY),
            "groq": bool(GROQ_KEY),
        },
    }


# ============================================================
# Endpoint principal
# ============================================================
@app.post("/analyze")
async def analyze(req: AnalyzeRequest, bg: BackgroundTasks):
    """Aceita o pedido, retorna 202 e processa async via callback."""
    bg.add_task(process_async, req)
    return {"ok": True, "accepted": True, "run_id": req.run_id}


# ============================================================
# Pipeline
# ============================================================
async def process_async(req: AnalyzeRequest):
    """Pipeline completo de QA: download -> análise estática -> LLM -> callback."""
    t0 = time.time()
    payload_callback: dict[str, Any] = {
        "run_id": req.run_id,
        "confidence_score": 0.0,
        "sintaxe_ok": False,
        "resolves_problem": False,
        "is_functional": False,
        "reasons": [],
        "suggestions": [],
        "llm_provider": None,
        "llm_model": None,
        "tokens_input": 0,
        "tokens_output": 0,
        "cost_usd_cents": 0,
    }
    extracted_text = ""

    try:
        # 1. Download (se package_url presente)
        if req.package_url:
            try:
                extracted_text = await download_and_extract(req.package_url)
            except Exception as e:
                # FIX-WORKER-12 pass 277 (DLP download_failed paridade pass 258):
                #   PRE-FIX: append raw f"download_failed: {e}" expoe paths
                #   sensitive (/var/lib/docker/...) + URL parts com tokens
                #   Pass 258 W12 fixou outer exception (linha 178+) mas inner
                #   download_failed ficou lagged.
                #   POST-FIX: sanitize com mesma regex pass 258
                import re as _dlp_re
                raw_msg = str(e)[:300]
                safe_msg = _dlp_re.sub(
                    r'(sk-[A-Za-z0-9_\-]{16,}|Bearer\s+[A-Za-z0-9_\-\.]+|/var/lib/[^\s]+|/etc/[^\s]+)',
                    '[REDACTED]', raw_msg
                )
                payload_callback["reasons"].append(f"download_failed: {safe_msg[:200]}")
                extracted_text = ""

        # 2. Analise estatica baseada em tipo
        static_findings = static_analysis(req.kind, extracted_text, req.description)
        payload_callback["sintaxe_ok"] = static_findings["sintaxe_ok"]
        if static_findings["issues"]:
            payload_callback["reasons"].extend(static_findings["issues"])

        # 3. LLM scoring com fallback
        prompt = build_prompt(req, extracted_text[:30_000], static_findings)
        llm_out, provider, model, usage = await call_llm_fallback(prompt)

        # 4. Parse score JSON
        score = parse_score_response(llm_out)
        # FIX-WORKER-12 pass 243 (sintaxe_ok AND merge):
        #   PRE-FIX: payload_callback["sintaxe_ok"] setado pela analise estatica
        #   linha 137 e NUNCA sobrescrito pelo LLM update. Cenario:
        #   - static_analysis nao detecta erro complexo (passa sintaxe_ok=True)
        #   - LLM detecta logic error semantico (retorna sintaxe_ok=False)
        #   - Payload final mantem sintaxe_ok=True (perde LLM verdict)
        #   - QA approve produto com erro real
        #   POST-FIX: AND logical merge - sintaxe_ok=True so se AMBOS concordam
        #   (defensive overhaul - melhor false-negative que false-positive QA)
        payload_callback.update({
            "confidence_score": score["confidence_score"],
            "sintaxe_ok": bool(payload_callback["sintaxe_ok"]) and bool(score.get("sintaxe_ok", True)),
            "resolves_problem": score.get("resolves_problem", False),
            "is_functional": score.get("is_functional", False),
            "llm_provider": provider,
            "llm_model": model,
            "tokens_input": usage.get("prompt_tokens", 0),
            "tokens_output": usage.get("completion_tokens", 0),
        })
        # Combina razoes da analise estatica + LLM
        if score.get("reasons"):
            payload_callback["reasons"].extend(score["reasons"])
        if score.get("suggestions"):
            payload_callback["suggestions"] = score["suggestions"]

        # 5. Estimar custo (preco aproximado por 1k tokens)
        cost = estimate_cost(provider, model, usage)
        payload_callback["cost_usd_cents"] = cost

    except Exception as e:
        # FIX-WORKER-12 pass 258 (DLP outer exception message):
        #   PRE-FIX: str(e)[:200] - exception msg pode conter:
        #   - sk-... / Bearer tokens (LLM API errors raw URL/headers)
        #   - paths sensitive ("/var/lib/docker/volumes/node_datad/_data/...")
        #   - User CPFs/emails (parse fail no payload)
        #   reasons[] vai p/ DB product_qa_runs + seller pode ver via UI
        #   /seller/products/{id} -> seller pode ver secrets/PII.
        #   POST-FIX: regex strip secrets antes de gravar.
        #   Pattern V8 DLP - mesmo principio _sanitize_llm_error (pass 248)
        import re as _dlp_re
        raw_msg = str(e)[:300]
        # Mask common secret patterns
        safe_msg = _dlp_re.sub(r'(sk-[A-Za-z0-9_\-]{16,}|Bearer\s+[A-Za-z0-9_\-\.]+|/var/lib/[^\s]+|/etc/[^\s]+)', '[REDACTED]', raw_msg)
        # Mask emails (PII LGPD)
        safe_msg = _dlp_re.sub(r'\b[\w\.\-]+@[\w\.\-]+\.\w+\b', '[email]', safe_msg)
        payload_callback["reasons"].append(f"worker_error: {safe_msg[:200]}")
        payload_callback["confidence_score"] = 0.0

    payload_callback["duration_ms"] = int((time.time() - t0) * 1000)

    # 6. Callback -> qa-svc
    await send_callback(req.callback_url, payload_callback)


# ============================================================
# Download + extract
# ============================================================
async def download_and_extract(url: str) -> str:
    """Baixa pacote (zip/json/txt) e retorna conteúdo extraído como string."""
    # Resolve URL relativa (storage local)
    if url.startswith("/uploads/"):
        local = Path("/var/lib/docker/volumes/node_datad/_data/code-agent-shop") / url.lstrip("/")
        if not local.exists():
            local = Path(os.getcwd()).parent.parent / url.lstrip("/")
        if local.exists():
            return read_file_safe(local)
        raise FileNotFoundError(f"package nao encontrado: {url}")

    async with httpx.AsyncClient(timeout=120) as cli:
        r = await cli.get(url)
        r.raise_for_status()
        if len(r.content) > MAX_PKG_BYTES:
            raise ValueError("package excede limite de tamanho")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as f:
            f.write(r.content)
            tmp = Path(f.name)
    try:
        return read_file_safe(tmp)
    finally:
        tmp.unlink(missing_ok=True)


def read_file_safe(path: Path) -> str:
    """Le arquivo com tratamento de ZIP/JSON/texto."""
    suffix = path.suffix.lower()
    if suffix == ".zip":
        out = []
        with zipfile.ZipFile(path) as z:
            for name in z.namelist()[:500]:
                if any(name.endswith(ext) for ext in [".js", ".ts", ".py", ".php", ".json", ".md", ".txt", ".yaml", ".yml", ".sh"]):
                    try:
                        with z.open(name) as f:
                            content = f.read(200_000).decode("utf-8", errors="ignore")
                            out.append(f"\n# FILE: {name}\n{content}\n")
                    except Exception:
                        pass
        return "\n".join(out)
    return path.read_text(encoding="utf-8", errors="ignore")[:200_000]


# ============================================================
# Analise estatica
# ============================================================
def static_analysis(kind: str, text: str, description: str) -> dict:
    """Analise rapida sem LLM: detecta mock/vazio/lixo."""
    issues: list[str] = []
    sintaxe_ok = True

    if not text or len(text.strip()) < 50:
        issues.append("Pacote vazio ou conteudo insuficiente (<50 chars).")
        sintaxe_ok = False
        return {"sintaxe_ok": sintaxe_ok, "issues": issues}

    if kind == "n8n_workflow":
        try:
            data = json.loads(text) if text.strip().startswith("{") else None
            if data and isinstance(data, dict):
                nodes = data.get("nodes", [])
                if not nodes:
                    issues.append("Workflow n8n sem nos (nodes vazios).")
                    sintaxe_ok = False
                trigger_types = ["webhook", "scheduleTrigger", "cron", "manualTrigger", "emailTrigger"]
                has_trigger = any(any(t in n.get("type", "").lower() for t in trigger_types) for n in nodes)
                if not has_trigger:
                    issues.append("Workflow n8n sem no de gatilho identificavel.")
        except Exception:
            issues.append("JSON do workflow n8n invalido.")
            sintaxe_ok = False

    if kind in ("node_script", "automation"):
        if "require(" not in text and "import " not in text and "from " not in text:
            issues.append("Script Node parece nao importar nenhum modulo.")

    if kind == "python_script":
        if "def " not in text and "import " not in text:
            issues.append("Script Python sem definicoes ou imports.")

    # Detecta "Lorem ipsum" / placeholders
    lorem_count = len(re.findall(r"lorem ipsum|TODO|FIXME|insira aqui|seu codigo aqui", text, re.IGNORECASE))
    if lorem_count > 3:
        issues.append(f"Conteudo com {lorem_count} placeholders/TODOs (provavelmente mock).")

    if len(description) < 30:
        issues.append("Descricao muito curta (<30 chars).")

    return {"sintaxe_ok": sintaxe_ok, "issues": issues}


# ============================================================
# Prompt builder
# ============================================================
def build_prompt(req: AnalyzeRequest, code_excerpt: str, static_findings: dict) -> str:
    return f"""Voce e um auditor senior de codigo para um marketplace de automacoes e agentes IA.

Avalie o produto abaixo e responda APENAS em JSON valido, sem markdown, com esta estrutura:
{{
  "confidence_score": float entre 0.0 e 1.0,
  "sintaxe_ok": boolean,
  "resolves_problem": boolean,
  "is_functional": boolean,
  "reasons": ["razoes objetivas, max 10"],
  "suggestions": ["sugestoes de melhoria, max 5"]
}}

Criterios:
- sintaxe_ok: codigo compila/executa sem erros obvios?
- resolves_problem: a implementacao resolve a dor descrita no titulo/descricao?
- is_functional: e uma automacao real ou um mock vazio/lixo?
- confidence_score: media ponderada de qualidade, completude e seguranca.

REJEITAR (score<0.8) se:
- Codigo vazio, placeholder, lorem ipsum, TODO sem implementacao.
- Workflow n8n sem nos de trigger/output.
- JSON corrompido.
- Descricao nao bate com o codigo.

# PRODUTO
Titulo: {req.title}
Tipo: {req.kind}
Tech stack: {', '.join(req.tech_stack or [])}
APIs requeridas: {', '.join(req.api_keys_required or [])}

# DESCRICAO
{req.description[:2000]}

# INSTRUCOES DE INSTALACAO
{(req.install_instructions or '')[:1000]}

# ANALISE ESTATICA PRE-LLM
sintaxe_ok={static_findings['sintaxe_ok']}
issues_detectados={static_findings['issues']}

# CODIGO/CONTEUDO (amostra)
```
{code_excerpt}
```

Responda APENAS o JSON, nada mais."""


# ============================================================
# LLM fallback
# ============================================================
def _is_transient_error(e: Exception) -> bool:
    """FIX-WORKER-12 pass 192: classifica erro p/ decidir fallback.

    Transient (deve fallback): timeout, 429 (rate-limit), 5xx (provider down).
    Permanent (NAO deve fallback): 400/401/403/404 (request invalido ou
    auth bad - mesmo erro reproduz nos outros providers se for nosso prompt).

    Sem essa classificacao, prompt malformado dispara 3 chamadas LLM falhas
    consumindo 60s budget total + 3x cost reporting + 3x retry storm.
    """
    if isinstance(e, httpx.TimeoutException):
        return True
    if isinstance(e, httpx.HTTPStatusError):
        status = e.response.status_code
        # 429 rate-limit, 5xx upstream -> retry com outro provider
        return status == 429 or status >= 500
    # Network errors, parsing -> transient (rede instavel)
    return True


def _sanitize_llm_error(e: Exception) -> str:
    """FIX-WORKER-12 pass 192: DLP em error message. Upstream pode retornar
    'Bearer <key>...' em body de 401, ou 'sk-xxx' em payload validation.
    Mantem so type + status (sem body)."""
    if isinstance(e, httpx.HTTPStatusError):
        return f"{type(e).__name__} status={e.response.status_code}"
    if isinstance(e, httpx.TimeoutException):
        return f"{type(e).__name__} timeout={LLM_PROVIDER_TIMEOUT}s"
    return type(e).__name__


async def call_llm_fallback(prompt: str) -> tuple[str, str, str, dict]:
    """OpenAI -> Gemini -> Groq.

    FIX-WORKER-12 pass 192:
    - Per-provider timeout LLM_PROVIDER_TIMEOUT (default 20s)
    - Permanent errors (400/401/403) NAO disparam fallback (fail fast)
    - Sanitized error messages (DLP - secrets em upstream body)
    """
    errors = []
    if OPENAI_KEY:
        try:
            return await _call_openai(prompt)
        except Exception as e:
            errors.append(f"openai: {_sanitize_llm_error(e)}")
            if not _is_transient_error(e):
                raise RuntimeError(f"OpenAI permanent error - fallback skipped. {errors[-1]}")
    if GEMINI_KEY:
        try:
            return await _call_gemini(prompt)
        except Exception as e:
            errors.append(f"gemini: {_sanitize_llm_error(e)}")
            if not _is_transient_error(e):
                raise RuntimeError(f"Gemini permanent error - fallback skipped. {'; '.join(errors)}")
    if GROQ_KEY:
        try:
            return await _call_groq(prompt)
        except Exception as e:
            errors.append(f"groq: {_sanitize_llm_error(e)}")
    raise RuntimeError("Nenhum provider LLM disponivel. " + "; ".join(errors))


async def _call_openai(prompt: str) -> tuple[str, str, str, dict]:
    async with httpx.AsyncClient(timeout=LLM_PROVIDER_TIMEOUT) as cli:
        r = await cli.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            json={
                "model": OPENAI_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
        )
        r.raise_for_status()
        d = r.json()
        # FIX-WORKER-12 pass 248 (defensive shape):
        #   PRE-FIX: d["choices"][0]["message"]["content"] direto - KeyError se
        #   API retorna {} ou {"choices":[]} (edge cases: quota exceeded silent
        #   200, A/B test new response shape, malformed JSON parsed empty).
        #   Crash propaga -> callback nunca enviado -> run stuck em 'running'
        #   ate cron timeout 10min consumir budget LLM novamente.
        #   POST-FIX: defensive .get chain - raise RuntimeError com context
        #   detail. Permite fallback chain capturar como transient error.
        choices = d.get("choices") or []
        if not choices:
            raise RuntimeError(f"openai_empty_response (model={OPENAI_MODEL})")
        msg = (choices[0] or {}).get("message") or {}
        content = msg.get("content") or ""
        if not content:
            raise RuntimeError(f"openai_no_content (model={OPENAI_MODEL})")
        return content, "openai", OPENAI_MODEL, d.get("usage", {})


async def _call_gemini(prompt: str) -> tuple[str, str, str, dict]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"
    async with httpx.AsyncClient(timeout=LLM_PROVIDER_TIMEOUT) as cli:
        r = await cli.post(url, json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.1, "response_mime_type": "application/json"},
        })
        r.raise_for_status()
        d = r.json()
        # FIX-WORKER-12 pass 248: defensive (mesmo pattern OpenAI)
        # Gemini retorna {"candidates":[]} quando safety filters blocam prompt
        candidates = d.get("candidates") or []
        if not candidates:
            block_reason = d.get("promptFeedback", {}).get("blockReason", "unknown")
            raise RuntimeError(f"gemini_no_candidates (reason={block_reason})")
        parts = (candidates[0] or {}).get("content", {}).get("parts") or []
        content = parts[0].get("text", "") if parts else ""
        if not content:
            raise RuntimeError(f"gemini_empty_content (model={GEMINI_MODEL})")
        meta = d.get("usageMetadata", {})
        return content, "gemini", GEMINI_MODEL, {
            "prompt_tokens": meta.get("promptTokenCount", 0),
            "completion_tokens": meta.get("candidatesTokenCount", 0),
        }


async def _call_groq(prompt: str) -> tuple[str, str, str, dict]:
    async with httpx.AsyncClient(timeout=LLM_PROVIDER_TIMEOUT) as cli:
        r = await cli.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_KEY}"},
            json={
                "model": GROQ_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
        )
        r.raise_for_status()
        d = r.json()
        # FIX-WORKER-12 pass 248: defensive (paridade OpenAI/Gemini)
        choices = d.get("choices") or []
        if not choices:
            raise RuntimeError(f"groq_empty_response (model={GROQ_MODEL})")
        msg = (choices[0] or {}).get("message") or {}
        content = msg.get("content") or ""
        if not content:
            raise RuntimeError(f"groq_no_content (model={GROQ_MODEL})")
        return content, "groq", GROQ_MODEL, d.get("usage", {})


# ============================================================
# Parser tolerante
# ============================================================
def parse_score_response(text: str) -> dict:
    """Extrai JSON do output do LLM (tolerante a markdown wrapping).

    FIX-WORKER-12 pass 2: garante reasons[] e sintaxe_ok/resolves_problem/is_functional
    defaults sempre populados. Antes: se LLM retornava JSON minimo com so confidence_score,
    o callback gravava reasons=null no DB e seller via 'Necessario ajustar' sem motivo
    no email.
    """
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {
            "confidence_score": 0.0,
            "sintaxe_ok": False,
            "resolves_problem": False,
            "is_functional": False,
            "reasons": ["Falha ao parsear resposta do modelo LLM. Tente reenviar."],
            "suggestions": [],
        }
    try:
        data = json.loads(m.group(0))
        # Sanitize/normalize todos os campos esperados pelo callback
        score = float(data.get("confidence_score", 0) or 0)
        data["confidence_score"] = max(0.0, min(1.0, score))
        data["sintaxe_ok"] = bool(data.get("sintaxe_ok", False))
        data["resolves_problem"] = bool(data.get("resolves_problem", False))
        data["is_functional"] = bool(data.get("is_functional", False))
        reasons = data.get("reasons") or []
        data["reasons"] = [str(r)[:300] for r in (reasons if isinstance(reasons, list) else [reasons])][:10]
        # Se score=0 mas LLM nao deu motivos, adiciona generic para o seller saber
        if data["confidence_score"] < 0.8 and not data["reasons"]:
            data["reasons"] = ["LLM rejeitou sem motivos especificos. Revise descricao + codigo."]
        suggestions = data.get("suggestions") or []
        data["suggestions"] = [str(s)[:300] for s in (suggestions if isinstance(suggestions, list) else [suggestions])][:5]
        return data
    except Exception as e:
        return {
            "confidence_score": 0.0,
            "sintaxe_ok": False,
            "resolves_problem": False,
            "is_functional": False,
            "reasons": [f"JSON invalido do LLM: {str(e)[:200]}"],
            "suggestions": [],
        }


# ============================================================
# Estimativa de custo (centavos USD)
# ============================================================
PRICING = {
    # USD por 1M tokens, multiplicar por 100 = cents
    ("openai", "gpt-4o-mini"):    {"in": 0.15,  "out": 0.60},
    ("openai", "gpt-4o"):         {"in": 2.50,  "out": 10.00},
    ("gemini", "gemini-2.0-flash"): {"in": 0.10, "out": 0.40},
    ("groq", "llama-3.3-70b-versatile"): {"in": 0.59, "out": 0.79},
}


def estimate_cost(provider: str, model: str, usage: dict) -> int:
    """FIX-WORKER-12 pass 2: fallback pricing por provider se modelo nao mapeado.
    Antes: model novo (ex 'gpt-4o-2024-08-06') retornava 0 -> custo subnotificado
    na tabela product_qa_runs.cost_usd_cents (billing nao registrado).

    Fallback por provider usa media historica como estimativa conservadora."""
    p = PRICING.get((provider, model))
    if not p:
        # Default por provider (estimativa conservadora - prefere superestimar)
        FALLBACK = {
            "openai":  {"in": 2.50,  "out": 10.00},  # GPT-4o ballpark
            "gemini":  {"in": 0.10,  "out": 0.40},   # Flash ballpark
            "groq":    {"in": 0.59,  "out": 0.79},   # 70b ballpark
        }
        p = FALLBACK.get(provider)
        if not p:
            print(f"[qa-worker] WARN cost unknown for {provider}/{model}, returning 0", flush=True)
            return 0
        print(f"[qa-worker] WARN model '{model}' nao mapeado em PRICING. Usando fallback {provider}", flush=True)
    tin = usage.get("prompt_tokens", 0) / 1_000_000
    tout = usage.get("completion_tokens", 0) / 1_000_000
    usd = tin * p["in"] + tout * p["out"]
    # FIX-WORKER-12 pass 229 (cost unit bug): tabela product_qa_runs.cost_usd_cents
    # e BIGINT em CENTS USD (1 USD = 100 cents). PRE-FIX: usd * 100 * 100 = 10000
    # multiplier (centesimos de centavo) -> custos 100x inflados no DB:
    # exemplo gpt-4o-mini run de $0.0005 gravava 5 cents (correto seria 0.05 cents).
    # Billing dashboard mostrava admin tinha $500 gastos quando real era $5.
    # POST-FIX: round(usd * 100) = cents (mesma unidade do schema sellers.cost_usd_cents
    # mig 003 + product_qa_runs.cost_usd_cents mig 005).
    return round(usd * 100)  # USD -> cents (BIGINT in DB)


# ============================================================
import hmac as _hmac
import hashlib as _hashlib

# Callback
# ============================================================
# FIX-WORKER-12 pass 2 (SSRF protection): worker so envia callback para URLs
# que matchem o pattern interno do qa-svc service mesh. Antes: callback_url
# vinha do payload (controlled por qa-svc) - se qa-svc fosse comprometido (W12
# pass 1 ja fechou auth, mas defense-in-depth), atacante podia setar
# callback_url = http://attacker.com/leak e o worker postaria dados sensiveis.
# Whitelist: tasks.cas_qa-svc:PORT (service mesh) + override env (dev/test).
import re as _re
def _is_callback_url_allowed(url: str) -> bool:
    if not url:
        return False
    allowed_override = os.getenv("QA_CALLBACK_ALLOWED_HOSTS", "")
    # Default seguro: aceita apenas service mesh interno (tasks.cas_qa-svc) ou
    # localhost (dev local). Producao deve set QA_CALLBACK_ALLOWED_HOSTS se
    # outro destino legitimo.
    default_patterns = [
        r"^https?://tasks\.cas_qa-svc(:\d+)?(/.*)?$",
        r"^https?://qa-svc(:\d+)?(/.*)?$",
        r"^https?://127\.0\.0\.1(:\d+)?(/.*)?$",
        r"^https?://localhost(:\d+)?(/.*)?$",
    ]
    patterns = default_patterns + [p.strip() for p in allowed_override.split(",") if p.strip()]
    return any(_re.match(p, url) for p in patterns)


async def send_callback(url: str, payload: dict):
    """FIX-WORKER-12: callback sempre assinado com HMAC SHA-256 do body
    usando QA_CALLBACK_SECRET (mesma chave em qa-svc). Sem isso, atacantes
    podiam forjar callback aprovando produtos sem QA real.

    FIX-WORKER-12 pass 2: valida callback_url contra whitelist de hosts
    internos antes do POST (SSRF defense-in-depth).

    json.dumps com separators=(',', ':') + sort_keys=False bate com JSON.stringify
    do Node por default. Para evitar divergencia, qa-svc valida sobre o body raw."""
    import json as _json
    if not _is_callback_url_allowed(url):
        print(f"[qa-worker] callback_url REJECTED (SSRF protection): {url[:120]}", flush=True)
        return
    secret = os.getenv("QA_CALLBACK_SECRET", "")
    body_bytes = _json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    headers = {"Content-Type": "application/json"}
    if secret:
        sig = _hmac.new(secret.encode(), body_bytes, _hashlib.sha256).hexdigest()
        headers["X-Signature"] = sig
    else:
        print("[qa-worker] WARN callback sem assinatura - QA_CALLBACK_SECRET ausente", flush=True)
    # FIX-WORKER-12 pass 309 (callback retry on non-2xx + exception):
    #   PRE-FIX: cli.post sem raise_for_status() + sem retry. Cenarios fail:
    #   - qa-svc retorna 401 (HMAC mismatch transient) -> payload perdido
    #   - 500 internal (deadlock PG) -> payload perdido + product stuck qa_running
    #   - network blip (5xx Traefik) -> payload perdido
    #   Worker descobre via cron qa-svc timeoutStuckRuns (10 min) - delay UX seller.
    #   POST-FIX: 3 retries com backoff exponencial (1s, 3s, 9s) + raise_for_status.
    #   Falha final NAO cria entry DB - confiamos cron timeout (defesa em camada).
    masked_url = url[:60] + ("..." if len(url) > 60 else "")
    last_err_type = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=30) as cli:
                r = await cli.post(url, content=body_bytes, headers=headers)
            if 200 <= r.status_code < 300:
                if attempt > 0:
                    print(f"[qa-worker] callback OK apos retry attempt={attempt} url_prefix={masked_url}", flush=True)
                return
            # FIX-WORKER-12 pass 326: classify retry by status code.
            # PRE-FIX pass 309: retry para QUALQUER non-2xx (4xx + 5xx).
            # 4xx errors sao permanentes (bad payload, HMAC mismatch real):
            #   - 400 schema invalido = bug code worker
            #   - 401 HMAC mismatch = QA_CALLBACK_SECRET inconsistent
            #   - 404 run_id nao existe = race com qa-svc cleanup
            # Retry 4xx waste budget + atrasa cron fallback discovery.
            # POST-FIX: 5xx retry (transient), 4xx fail-fast.
            # Pattern paridade notif-svc pass 219 (transient classification).
            last_err_type = f"http_{r.status_code}"
            print(f"[qa-worker] callback non-2xx attempt={attempt} status={r.status_code} url_prefix={masked_url}", flush=True)
            if 400 <= r.status_code < 500:
                # Permanent failure - no retry
                print(f"[qa-worker] callback PERMANENT_FAIL status={r.status_code} skipping retries url_prefix={masked_url}", flush=True)
                return
        except Exception as e:
            # FIX-WORKER-12 pass 272 (DLP callback failure log):
            #   PRE-FIX: print(f"callback FAIL: {e}") - exception pode conter:
            #   - Authorization headers em httpx connection errors
            #   - URL parts revealing internal mesh (tasks.cas_qa-svc:port)
            #   - Stack traces with config paths
            #   POST-FIX: sanitize via type+code-only (no raw msg)
            last_err_type = type(e).__name__
            print(f"[qa-worker] callback EXCEPTION attempt={attempt} type={last_err_type} url_prefix={masked_url}", flush=True)
        # Backoff exponencial (1s, 3s) - skip ultimo attempt
        if attempt < 2:
            await asyncio.sleep([1, 3][attempt])
    print(f"[qa-worker] callback FAIL exhausted retries last_err={last_err_type} url_prefix={masked_url}", flush=True)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT_QA_WORKER", "3014"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=False, log_level="info")
