import { LoanCalculator } from '@/components/loan-calculator';
import { todayBogota } from '@/lib/finance';
import { requestLoan } from '@/app/simulador/actions';

export const metadata = { title: 'Simular préstamo' };

export default function CustomerSimulatorPage() {
  return (
    <>
      <h1 className="text-2xl font-bold">Simular préstamo</h1>
      <p className="mb-4 text-sm text-slate-500">Vea cuánto pagaría. Simular no le crea ninguna deuda.</p>
      <LoanCalculator today={todayBogota()} action={requestLoan} submitLabel="Pedir este préstamo" />
    </>
  );
}
