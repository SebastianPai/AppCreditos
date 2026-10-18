import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireRole } from '@/lib/auth';

export default async function CustomerLayout({ children }: { children: ReactNode }) {
  const profile = await requireRole('customer');
  return <AppShell profile={profile}>{children}</AppShell>;
}
