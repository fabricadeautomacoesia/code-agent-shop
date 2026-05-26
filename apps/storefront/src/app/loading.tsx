export default function Loading() {
  return (
    <div className="container mx-auto px-6 py-32 flex items-center justify-center">
      <div className="text-center">
        <div className="inline-block w-16 h-16 rounded-full bg-gradient-vibe animate-glow-pulse mb-4" />
        <div className="text-white/60 font-display animate-pulse">Carregando...</div>
      </div>
    </div>
  );
}
