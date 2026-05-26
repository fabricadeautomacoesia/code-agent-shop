#!/usr/bin/env python3
"""
vps-deploy.py - automacao de SSH com senha para deploy na VPS.
Uso: python bin/vps-deploy.py [check|bootstrap|deploy|smoke]
"""
import os
import sys
import subprocess

VPS_HOST = os.getenv('VPS_HOST', '209.145.60.53')
VPS_USER = os.getenv('VPS_USER', 'root')
VPS_PASS = os.getenv('VPS_PASS', 'sW5pgAG9obRu')


def run_remote(commands: str, timeout: int = 300) -> tuple[int, str]:
    """Executa comandos remotos via ssh + sshpass-like usando pexpect-pure."""
    import pty
    import select

    cmd = [
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'PreferredAuthentications=password,keyboard-interactive',
        '-o', 'PubkeyAuthentication=no',
        '-o', 'ConnectTimeout=15',
        f'{VPS_USER}@{VPS_HOST}',
        commands,
    ]
    master, slave = pty.openpty()
    proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    output = []
    sent_pw = False

    import time
    start = time.time()
    while True:
        if time.time() - start > timeout:
            proc.kill()
            break
        r, _, _ = select.select([master], [], [], 0.5)
        if master in r:
            try:
                chunk = os.read(master, 4096).decode('utf-8', errors='replace')
                output.append(chunk)
                if not sent_pw and ('assword:' in chunk or 'password:' in chunk):
                    os.write(master, (VPS_PASS + '\n').encode())
                    sent_pw = True
            except OSError:
                break
        if proc.poll() is not None:
            try:
                while True:
                    chunk = os.read(master, 4096).decode('utf-8', errors='replace')
                    if not chunk:
                        break
                    output.append(chunk)
            except OSError:
                pass
            break
    os.close(master)
    return proc.returncode or 0, ''.join(output)


CMD_CHECK = """
echo '=== VPS ==='
uname -a
echo
echo '=== Docker ==='
docker --version 2>&1 | head -1 || echo 'NO DOCKER'
docker compose version 2>&1 | head -1 || echo 'NO COMPOSE'
echo
echo '=== Swarm ==='
docker info 2>/dev/null | grep -iE 'swarm|nodes' | head -3 || echo 'NO SWARM'
echo
echo '=== Stacks ==='
docker stack ls 2>&1 | head -10
echo
echo '=== Containers running ==='
docker ps --format '{{.Names}}\t{{.Image}}' 2>&1 | head -20
echo
echo '=== Volumes externos ==='
docker volume ls 2>&1 | grep -E 'node_datad|php82_datad|python_datad'
echo
echo '=== Networks ==='
docker network ls 2>&1 | grep -E 'swarm_public|overlay'
echo
echo '=== Disk ==='
df -h / 2>&1 | tail -1
echo '=== Memory ==='
free -h 2>&1 | head -2
"""


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'check'
    if action == 'check':
        print(f'[vps-deploy] conectando em {VPS_USER}@{VPS_HOST} (check)...')
        rc, out = run_remote(CMD_CHECK)
        print(out)
        print(f'\n[vps-deploy] exit code={rc}')
    elif action == 'bootstrap':
        # bootstrap: instalar Docker se faltar + Swarm init + criar volumes + network
        rc, out = run_remote("""
            set -e
            command -v docker >/dev/null 2>&1 || { curl -fsSL https://get.docker.com | sh; }
            systemctl start docker || true
            docker info 2>/dev/null | grep -q 'Swarm: active' || docker swarm init --advertise-addr $(hostname -I | awk '{print $1}')
            docker network ls | grep -q network_swarm_public || docker network create -d overlay --attachable network_swarm_public
            docker volume ls | grep -q node_datad || docker volume create node_datad
            docker volume ls | grep -q php82_datad || docker volume create php82_datad
            docker volume ls | grep -q python_datad || docker volume create python_datad
            echo 'bootstrap OK'
        """)
        print(out)
        sys.exit(rc)
    elif action == 'pull':
        rc, out = run_remote("""
            set -e
            mkdir -p /opt/cas && cd /opt/cas
            if [ ! -d .git ]; then
              git clone https://github.com/fabricadeautomacoesia/code-agent-shop.git .
            else
              git fetch && git reset --hard origin/main
            fi
            ls -la
        """)
        print(out)
        sys.exit(rc)
    else:
        print(f'Acao desconhecida: {action}')
        print('Acoes: check, bootstrap, pull')
        sys.exit(2)


if __name__ == '__main__':
    main()
