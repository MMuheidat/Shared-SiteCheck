import { NextResponse } from 'next/server';

// The pillar list matching the engine registry — avoids importing engine deps at the edge
const PILLARS = [
  { name: 'Discovery & Access', nameAR: 'الاكتشاف والوصول', index: 1 },
  { name: 'Accessibility & Inclusion', nameAR: 'إمكانية الوصول والشمولية', index: 2 },
  { name: 'Website Structure', nameAR: 'هيكل الموقع', index: 3 },
  { name: 'Navigation', nameAR: 'التنقل', index: 4 },
  { name: 'Registration', nameAR: 'التسجيل', index: 5 },
  { name: 'Services', nameAR: 'الخدمات', index: 6 },
  { name: 'Performance', nameAR: 'الأداء', index: 7 },
  { name: 'Customer Privacy', nameAR: 'خصوصية العملاء', index: 8 },
  // Beta pillars: require LLM installation/integration — excluded from "Run All Pillars",
  // still runnable individually while the integration is pending.
  { name: 'Live Chat', nameAR: 'الدردشة المباشرة', index: 9, beta: true },
  { name: 'Enquiry Form Journey', nameAR: 'رحلة نموذج الاستفسار', index: 10, beta: true },
];

export async function GET() {
  return NextResponse.json({ pillars: PILLARS });
}
