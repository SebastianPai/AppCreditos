import { Simulator } from '@/components/simulator';
import { PageHeader } from '@/components/ui';
import { requireRole } from '@/lib/auth';
import { todayBogota } from '@/lib/finance';
import { requestLoan, saveSimulation } from './actions';

export const metadata = { title: 'Simulador de préstamos' };

export default async function PublicSimulatorPage() {
  const profile = await requireRole('admin', 'collector', 'partner', 'customer');
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 lg:px-8">
      <PageHeader title="Simular un préstamo" subtitle="Calcule el valor de las cuotas y compare las modalidades. La simulación no crea ninguna deuda." />
      <Simulator today={todayBogota()} saveAction={saveSimulation} applyAction={requestLoan} canApply={profile.role === 'customer'} />
    </main>
  );
}
