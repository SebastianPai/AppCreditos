/** Flecha de subida o bajada del puntaje (último cambio). */
export function Trend({ change }: { change: number }) {
  if (!change) return <span className="text-sm text-slate-400">—</span>;
  return change > 0
    ? <span className="rounded-full bg-slate-800 px-3 py-1 text-sm font-semibold text-white">▲ Subió {change}</span>
    : <span className="rounded-full bg-red-100 px-3 py-1 text-sm font-semibold text-red-800">▼ Bajó {-change}</span>;
}
