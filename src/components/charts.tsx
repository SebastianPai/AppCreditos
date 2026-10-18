'use client';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const cop = (v: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
const compact = (v: number) => new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

export function DailyCollectionsChart({ data }: { data: { date: string; amount: number; interest: number }[] }) {
  const rows = data.map((d) => ({ ...d, label: d.date.slice(5).split('-').reverse().join('/'), principal: d.amount - d.interest }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
          <Tooltip formatter={(v) => cop(Number(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="principal" name="Capital recuperado" stackId="a" fill="#059669" />
          <Bar dataKey="interest" name="Interés" stackId="a" fill="#f59e0b" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MonthlyChart({ data }: { data: { month: string; disbursed: number; collected: number; interest: number }[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
          <Tooltip formatter={(v) => cop(Number(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="disbursed" name="Desembolsado" fill="#0ea5e9" />
          <Bar dataKey="collected" name="Recaudado" fill="#059669" />
          <Bar dataKey="interest" name="Interés" fill="#f59e0b" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
