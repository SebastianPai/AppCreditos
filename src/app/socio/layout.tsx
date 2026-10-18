import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireRole } from '@/lib/auth';

export default async function PartnerLayout({ children }: { children: ReactNode }) {
  const profile = await requireRole('partner');
  return <AppShell profile={profile}>{children}</AppShell>;
}
