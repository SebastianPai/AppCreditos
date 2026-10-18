import 'server-only';
import ExcelJS from 'exceljs';
import type { CollectorReport } from '@/components/collector-report';

const COP = '"$"#,##0';

function sheetWithRows(wb: ExcelJS.Workbook, name: string, rows: [string, string | number][]) {
  const ws = wb.addWorksheet(name);
  ws.columns = [{ width: 46 }, { width: 22 }];
  for (const [k, v] of rows) {
    const r = ws.addRow([k, v]);
    if (typeof v === 'number') r.getCell(2).numFmt = COP;
  }
  ws.getRow(1).font = { bold: true };
  return ws;
}

export async function collectorReportWorkbook(r: CollectorReport): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Capital Control';
  sheetWithRows(wb, 'Resumen', [
    ['Informe de cobro', `${r.from} a ${r.to}`],
    ['Cobrador responsable', r.collector?.full_name ?? ''],
    ['Personas que pagaron', r.payers],
    ['Pagos registrados', r.payments_count],
    ['Cuotas con abonos', r.installments_touched],
    ['Cuotas completadas', r.installments_completed],
    ['Pagos parciales', r.partial_payments],
    ['Total recibido', r.total_received],
    ['Capital recuperado', r.principal_recovered],
    ['Intereses recaudados', r.interest_collected],
    ['Comisión devengada', r.commission_accrued],
    ['Comisión pagada', r.commission_paid],
    ['Dinero entregado a administración', r.handed_over],
    ['Efectivo en poder del cobrador', r.cash_in_custody],
    ['Dinero esperado', r.expected],
    ['Diferencia recibido − esperado', r.difference],
    ['Cuotas pendientes', r.pending_installments],
    ['Valor pendiente', r.pending_amount],
  ]);
  const ws = wb.addWorksheet('Pagos');
  ws.columns = [
    { header: 'Recibo', key: 'receipt_number', width: 10 },
    { header: 'Fecha', key: 'received_on', width: 12 },
    { header: 'Cliente', key: 'customer', width: 30 },
    { header: 'Préstamo', key: 'loan_code', width: 12 },
    { header: 'Valor', key: 'amount', width: 14, style: { numFmt: COP } },
    { header: 'Capital', key: 'principal', width: 14, style: { numFmt: COP } },
    { header: 'Interés', key: 'interest', width: 14, style: { numFmt: COP } },
    { header: 'Comisión', key: 'commission', width: 14, style: { numFmt: COP } },
    { header: 'Parcial', key: 'partial', width: 8 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const p of r.payments) ws.addRow({ ...p, partial: p.is_partial ? 'Sí' : 'No' });
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

export interface SettlementReport {
  period_start: string;
  period_end: string;
  opening_cash: number;
  capital_recovered: number;
  new_disbursements: number;
  interest_collected: number;
  collector_commissions: number;
  expenses: number;
  adjustments: number;
  reversals_amount: number;
  period_result: number;
  prior_loss_carried: number;
  net_distributable: number;
  loss_carried_forward: number;
  distributions_paid_in_period: number;
  closing_cash: number;
  partners: { name: string; share_bps: number; gross: number; advances_deducted: number; net: number; contributions: number; withdrawals: number; advances_in_period: number }[];
}

export async function settlementWorkbook(r: SettlementReport, status: string, hash: string | null): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Capital Control';
  sheetWithRows(wb, 'Liquidación', [
    ['Liquidación de socios', `${r.period_start} a ${r.period_end}`],
    ['Estado', status],
    ['Saldo inicial (caja + cobradores)', r.opening_cash],
    ['Capital recuperado (no es ganancia)', r.capital_recovered],
    ['Nuevos desembolsos', r.new_disbursements],
    ['Intereses efectivamente cobrados', r.interest_collected],
    ['Comisiones del cobrador', r.collector_commissions],
    ['Gastos autorizados', r.expenses],
    ['Ajustes', r.adjustments],
    ['Reversos del periodo', r.reversals_amount],
    ['Resultado del periodo', r.period_result],
    ['Pérdida arrastrada de periodos anteriores', r.prior_loss_carried],
    ['Ganancia neta distribuible', r.net_distributable],
    ['Pérdida que pasa al siguiente periodo', r.loss_carried_forward],
    ['Distribuciones pagadas en el periodo', r.distributions_paid_in_period],
    ['Saldo final (caja + cobradores)', r.closing_cash],
    ['Huella SHA-256 del informe aprobado', hash ?? '—'],
  ]);
  const ws = wb.addWorksheet('Socios');
  ws.columns = [
    { header: 'Socio', key: 'name', width: 24 },
    { header: 'Participación %', key: 'pct', width: 15 },
    { header: 'Ganancia bruta', key: 'gross', width: 16, style: { numFmt: COP } },
    { header: 'Anticipos descontados', key: 'advances_deducted', width: 20, style: { numFmt: COP } },
    { header: 'Neto a pagar', key: 'net', width: 16, style: { numFmt: COP } },
    { header: 'Aportes en periodo', key: 'contributions', width: 18, style: { numFmt: COP } },
    { header: 'Retiros en periodo', key: 'withdrawals', width: 18, style: { numFmt: COP } },
    { header: 'Anticipos en periodo', key: 'advances_in_period', width: 18, style: { numFmt: COP } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const p of r.partners) ws.addRow({ ...p, pct: p.share_bps / 100 });
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
