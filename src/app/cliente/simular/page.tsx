import { Simulator } from '@/components/simulator';
import { PageHeader } from '@/components/ui';
import { todayBogota } from '@/lib/finance';
import { requestLoan, saveSimulation } from '@/app/simulador/actions';

export const metadata = { title: 'Simular nuevo préstamo' };

export default function CustomerSimulatorPage() {
  return (
    <>
      <PageHeader title="Simular nuevo préstamo" subtitle="Compare modalidades y cuotas. Si le conviene, envíe la solicitud: la administración la revisará." />
      <Simulator today={todayBogota()} saveAction={saveSimulation} applyAction={requestLoan} canApply />
    </>
  );
}
