import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireRole } from '@/lib/auth';

export default async function CollectorLayout({ children }: { children: ReactNode }) {
  const profile = await requireRole('collector');
  return <AppShell profile={profile}>{children}</AppShell>;
}
