// lib/scoring.ts — Criterion registry & scoring functions
import type { CriterionDefinition, CriterionResult, Grade, PillarScore } from '@/lib/types';

// ────────────────────────────────────────────────────────────
//  Full Criteria Registry
// ────────────────────────────────────────────────────────────
export const CRITERIA: CriterionDefinition[] = [
  // ── Pillar 1: Discovery & Access ──
  {
    qid: 'Q1',
    nameEN: 'Search Presence',
    nameAR: 'الظهور في محركات البحث',
    pillar: 'Discovery & Access',
    pillarAR: 'الاكتشاف والوصول',
    subPillar: 'Search Engine Visibility',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Submit your website to Google Search Console and ensure proper SEO meta tags (title, description, canonical URL) are present on every page.',
  },
  {
    qid: 'Q3',
    nameEN: 'Contact Info on Google Maps',
    nameAR: 'معلومات التواصل على خرائط جوجل',
    pillar: 'Discovery & Access',
    pillarAR: 'الاكتشاف والوصول',
    subPillar: 'Map Presence',
    maxScore: 2,
    isScored: true,
    recommendation:
      'Create and verify a Google Business Profile with accurate contact information, address, and operating hours.',
  },

  // ── Pillar 2: Accessibility & Inclusion ──
  {
    qid: 'Q4',
    nameEN: 'Multilingual Support',
    nameAR: 'دعم تعدد اللغات',
    pillar: 'Accessibility & Inclusion',
    pillarAR: 'إمكانية الوصول والشمولية',
    subPillar: 'Language Support',
    maxScore: 2,
    isScored: true,
    recommendation:
      'Provide the website in both Arabic and English. Add a clearly visible language switcher in the header area.',
  },
  {
    qid: 'Q5',
    nameEN: 'Language Switching Easy',
    nameAR: 'سهولة تبديل اللغة',
    pillar: 'Accessibility & Inclusion',
    pillarAR: 'إمكانية الوصول والشمولية',
    subPillar: 'Language Support',
    maxScore: 1,
    isScored: true,
    dependsOn: 'Q4',
    recommendation:
      'Place the language switcher in the header or top navigation bar so users can find it easily without scrolling.',
  },
  {
    qid: 'Q6',
    nameEN: 'Language Switch All Pages',
    nameAR: 'تبديل اللغة في جميع الصفحات',
    pillar: 'Accessibility & Inclusion',
    pillarAR: 'إمكانية الوصول والشمولية',
    subPillar: 'Language Support',
    maxScore: 1,
    isScored: true,
    dependsOn: 'Q4',
    recommendation:
      'Ensure the language switcher component is part of the global header/layout so it appears consistently on all pages.',
  },
  {
    qid: 'Q8',
    nameEN: 'Text Resizing',
    nameAR: 'تغيير حجم النص',
    pillar: 'Accessibility & Inclusion',
    pillarAR: 'إمكانية الوصول والشمولية',
    subPillar: 'Visual Accessibility',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Add text resizing controls (A+/A-/A buttons) in the header or an accessibility toolbar to allow users to adjust font size.',
  },
  {
    qid: 'Q9',
    nameEN: 'Screen Reader Compatibility',
    nameAR: 'توافق قارئ الشاشة',
    pillar: 'Accessibility & Inclusion',
    pillarAR: 'إمكانية الوصول والشمولية',
    subPillar: 'Visual Accessibility',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Add proper ARIA labels, roles, alt text for images, and use semantic HTML elements (nav, main, header, footer, article).',
  },
  {
    qid: 'Q10',
    nameEN: 'Color Contrast Adjustment',
    nameAR: 'تعديل تباين الألوان',
    pillar: 'Accessibility & Inclusion',
    pillarAR: 'إمكانية الوصول والشمولية',
    subPillar: 'Visual Accessibility',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Add a contrast adjustment control or high-contrast mode toggle in the accessibility toolbar.',
  },

  // ── Pillar 3: Website Structure ──
  {
    qid: 'Q14',
    nameEN: 'Consistent Layout',
    nameAR: 'تناسق التصميم',
    pillar: 'Website Structure',
    pillarAR: 'هيكل الموقع',
    subPillar: 'Layout Consistency',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Use a shared layout template so the header, navigation, and footer remain consistent across all pages.',
  },
  {
    qid: 'Q15',
    nameEN: 'Mobile Responsiveness',
    nameAR: 'الاستجابة للأجهزة المحمولة',
    pillar: 'Website Structure',
    pillarAR: 'هيكل الموقع',
    subPillar: 'Responsive Design',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Include a responsive viewport meta tag and use CSS media queries or a responsive framework to support mobile devices.',
  },

  // ── Pillar 4: Navigation ──
  {
    qid: 'Q12',
    nameEN: 'Social Media Links',
    nameAR: 'روابط وسائل التواصل الاجتماعي',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'External Links',
    maxScore: 2,
    isScored: true,
    recommendation:
      'Add social media links (e.g., Twitter/X, Facebook, Instagram, LinkedIn) in the footer or a dedicated section.',
  },
  {
    qid: 'Q13',
    nameEN: 'Search Bar',
    nameAR: 'شريط البحث',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'Search',
    maxScore: 2,
    isScored: true,
    recommendation:
      'Add a search bar in the header or top navigation area to let users search for content across the website.',
  },
  {
    qid: 'Q16',
    nameEN: 'Contact Details',
    nameAR: 'تفاصيل الاتصال',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'Contact Information',
    maxScore: 2,
    isScored: true,
    recommendation:
      'Provide a dedicated Contact Us page or section with phone number, email, and physical address.',
  },
  {
    qid: 'Q17',
    nameEN: 'Feedback Forms',
    nameAR: 'نماذج التغذية الراجعة',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'User Feedback',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Add a user feedback or satisfaction survey form accessible from the footer or a floating widget.',
  },
  {
    qid: 'Q18',
    nameEN: 'Clear Menu Labels',
    nameAR: 'وضوح عناوين القائمة',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'Menu Clarity',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Use descriptive, concise labels for all menu items. Avoid generic terms like "Miscellaneous" or "Other".',
  },
  {
    qid: 'Q19',
    nameEN: 'Content Free from Jargon',
    nameAR: 'محتوى خالٍ من المصطلحات',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'Content Clarity',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Write content in plain language. Avoid technical jargon and provide explanations for any specialized terms.',
  },
  {
    qid: 'Q20',
    nameEN: 'Clear Buttons and Links',
    nameAR: 'وضوح الأزرار والروابط',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'UI Clarity',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Use descriptive link text (avoid "click here") and ensure buttons have clear, action-oriented labels.',
  },
  {
    qid: 'Q22',
    nameEN: 'FAQ Section',
    nameAR: 'قسم الأسئلة الشائعة',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'Help & Support',
    maxScore: 2,
    isScored: true,
    recommendation:
      'Create a comprehensive FAQ section that addresses common user questions. Make it easily accessible from the navigation.',
  },
  {
    qid: 'Q30',
    nameEN: 'Smooth Navigation',
    nameAR: 'سلاسة التنقل',
    pillar: 'Navigation',
    pillarAR: 'التنقل',
    subPillar: 'Navigation Flow',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Ensure smooth page transitions, add breadcrumbs, and provide a clear navigation hierarchy.',
  },

  // ── Pillar 5: Registration ──
  {
    qid: 'Q23',
    nameEN: 'User Registration',
    nameAR: 'تسجيل المستخدم',
    pillar: 'Registration',
    pillarAR: 'التسجيل',
    subPillar: 'Registration Availability',
    maxScore: 0,
    isScored: false,
    recommendation:
      'Add a user registration/login feature to enable personalized services.',
  },
  {
    qid: 'Q23a',
    nameEN: 'UAE Pass Integration',
    nameAR: 'تكامل الهوية الرقمية',
    pillar: 'Registration',
    pillarAR: 'التسجيل',
    subPillar: 'Digital Identity',
    maxScore: 0,
    isScored: false,
    dependsOn: 'Q23',
    recommendation:
      'Integrate UAE Pass (digital identity) as a login option for seamless and secure user authentication.',
  },

  // ── Pillar 6: Services ──
  {
    qid: 'Q31',
    nameEN: 'Services List Location',
    nameAR: 'موقع قائمة الخدمات',
    pillar: 'Services',
    pillarAR: 'الخدمات',
    subPillar: 'Service Discovery',
    maxScore: 0,
    isScored: false,
    recommendation:
      'Provide a clear services/e-services section accessible from the main navigation menu.',
  },
  {
    qid: 'Q32a',
    nameEN: 'Info Tailored to User Groups',
    nameAR: 'معلومات مخصصة لفئات المستخدمين',
    pillar: 'Services',
    pillarAR: 'الخدمات',
    subPillar: 'User Segmentation',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Organize services and information by user groups (e.g., Individuals, Businesses, Government) to improve discoverability.',
  },
  {
    qid: 'Q33a',
    nameEN: 'Complete Service Info',
    nameAR: 'معلومات الخدمة الكاملة',
    pillar: 'Services',
    pillarAR: 'الخدمات',
    subPillar: 'Service Details',
    maxScore: 1,
    isScored: true,
    recommendation:
      'For each service, provide complete details including: description, requirements, fees, processing time, and steps.',
  },

  // ── Pillar 7: Performance ──
  {
    qid: 'Q26',
    nameEN: 'Website Operates Smoothly',
    nameAR: 'تشغيل الموقع بسلاسة',
    pillar: 'Performance',
    pillarAR: 'الأداء',
    subPillar: 'Stability',
    maxScore: 2,
    isScored: true,
    recommendation:
      'Fix JavaScript errors, ensure all resources load correctly, and test the website across different browsers.',
  },
  {
    qid: 'Q27',
    nameEN: 'No Broken Links',
    nameAR: 'عدم وجود روابط معطلة',
    pillar: 'Performance',
    pillarAR: 'الأداء',
    subPillar: 'Link Integrity',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Regularly audit all links on the website and fix or remove any broken links (404/500 errors).',
  },
  {
    qid: 'Q67',
    nameEN: 'Page Load Time',
    nameAR: 'وقت تحميل الصفحة',
    pillar: 'Performance',
    pillarAR: 'الأداء',
    subPillar: 'Speed',
    maxScore: 3,
    isScored: true,
    recommendation:
      'Optimize images, minify CSS/JS, leverage browser caching, and use a CDN to improve page load times to under 5 seconds.',
  },

  // ── Pillar 8: Customer Privacy ──
  {
    qid: 'Q35.1',
    nameEN: 'Privacy Policy Available',
    nameAR: 'توفر سياسة الخصوصية',
    pillar: 'Customer Privacy',
    pillarAR: 'خصوصية العملاء',
    subPillar: 'Privacy Policy',
    maxScore: 1,
    isScored: true,
    recommendation:
      'Create a comprehensive privacy policy page that explains how user data is collected, used, and protected.',
  },
  {
    qid: 'Q35',
    nameEN: 'Privacy Policy Easy to Find',
    nameAR: 'سهولة العثور على سياسة الخصوصية',
    pillar: 'Customer Privacy',
    pillarAR: 'خصوصية العملاء',
    subPillar: 'Privacy Policy',
    maxScore: 1,
    isScored: true,
    dependsOn: 'Q35.1',
    recommendation:
      'Add a direct link to the privacy policy in the website footer so it is accessible from every page.',
  },

  // ── Pillar 9: Live Chat ──
  {
    qid: 'Q37',
    nameEN: 'Live Chat Available',
    nameAR: 'توفر الدردشة المباشرة',
    pillar: 'Live Chat',
    pillarAR: 'الدردشة المباشرة',
    subPillar: 'Chat Availability',
    maxScore: 0,
    isScored: false,
    recommendation:
      'Add a live chat widget or chatbot to the website to provide real-time customer support.',
  },
  {
    qid: 'Q39',
    nameEN: 'Live Chat Load Time',
    nameAR: 'وقت تحميل الدردشة',
    pillar: 'Live Chat',
    pillarAR: 'الدردشة المباشرة',
    subPillar: 'Chat Performance',
    maxScore: 1,
    isScored: true,
    dependsOn: 'Q37',
    recommendation:
      'Ensure the live chat widget loads within 5 seconds of the page loading.',
  },
  {
    qid: 'Q40',
    nameEN: 'Live Chat Working Hours',
    nameAR: 'ساعات عمل الدردشة',
    pillar: 'Live Chat',
    pillarAR: 'الدردشة المباشرة',
    subPillar: 'Chat Availability',
    maxScore: 1,
    isScored: true,
    dependsOn: 'Q37',
    recommendation:
      'Display the live chat working hours clearly, or indicate that chat support is available 24/7.',
  },

  // ── Pillar 10: Enquiry Form ──
  {
    qid: 'Q53',
    nameEN: 'Enquiry Form Available',
    nameAR: 'توفر نموذج الاستفسار',
    pillar: 'Enquiry Form',
    pillarAR: 'نموذج الاستفسار',
    subPillar: 'Form Availability',
    maxScore: 0,
    isScored: false,
    recommendation:
      'Add a Contact Us / Enquiry form so users can submit questions without needing email.',
  },
  {
    qid: 'Q54',
    nameEN: 'Enquiry Form Submittable',
    nameAR: 'إمكانية إرسال نموذج الاستفسار',
    pillar: 'Enquiry Form',
    pillarAR: 'نموذج الاستفسار',
    subPillar: 'Form Functionality',
    maxScore: 2,
    isScored: true,
    dependsOn: 'Q53',
    recommendation:
      'Ensure the enquiry form has proper validation and a working submit button. Test form submission end-to-end.',
  },
  {
    qid: 'Q55',
    nameEN: 'Thank You Message',
    nameAR: 'رسالة الشكر',
    pillar: 'Enquiry Form',
    pillarAR: 'نموذج الاستفسار',
    subPillar: 'Form Feedback',
    maxScore: 1,
    isScored: true,
    dependsOn: 'Q54',
    recommendation:
      'Display a clear confirmation/thank-you message after successful form submission to reassure the user.',
  },
];

// ────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────

/** Look up a criterion definition by QID */
export function getCriterion(qid: string): CriterionDefinition | undefined {
  return CRITERIA.find((c) => c.qid === qid);
}

/** Get the default recommendation text for a QID */
export function getRecommendation(qid: string): string {
  const c = getCriterion(qid);
  return c?.recommendation ?? 'No recommendation available for this criterion.';
}

// ────────────────────────────────────────────────────────────
//  Grade helpers
// ────────────────────────────────────────────────────────────

function percentageToGrade(pct: number): Grade {
  if (pct >= 90) return 'Excellent';
  if (pct >= 75) return 'Good';
  if (pct >= 60) return 'Satisfactory';
  return 'Needs Improvement';
}

// Maximum possible score is derived from the active scored criteria.
// This keeps percentage output aligned with the rubric actually implemented in CRITERIA.
export function getMaxScore(): number {
  return CRITERIA.reduce((sum, criterion) => sum + (criterion.isScored ? criterion.maxScore : 0), 0);
}

export function calculateTotalScore(results: CriterionResult[]): {
  total: number;
  max: number;
  percentage: number;
  grade: Grade;
} {
  const total = results.reduce((sum, r) => sum + r.scoreEarned, 0);
  const max = getMaxScore();
  const percentage = Math.round((total / max) * 100);
  const grade = percentageToGrade(percentage);
  return { total, max, percentage, grade };
}

// ────────────────────────────────────────────────────────────
//  Pillar Scores
// ────────────────────────────────────────────────────────────

export function calculatePillarScores(results: CriterionResult[]): PillarScore[] {
  const pillarMap = new Map<string, { pillarAR: string; earned: number; max: number }>();

  for (const r of results) {
    if (r.maxScore === 0) continue; // skip non-scored

    if (!pillarMap.has(r.pillar)) {
      // Resolve Arabic pillar name from registry
      const def = CRITERIA.find((c) => c.pillar === r.pillar);
      pillarMap.set(r.pillar, {
        pillarAR: def?.pillarAR ?? r.pillar,
        earned: 0,
        max: 0,
      });
    }
    const entry = pillarMap.get(r.pillar)!;
    entry.earned += r.scoreEarned;
    entry.max += r.maxScore;
  }

  const scores: PillarScore[] = [];
  for (const [pillar, data] of pillarMap.entries()) {
    scores.push({
      pillar,
      pillarAR: data.pillarAR,
      earned: data.earned,
      max: data.max,
      percentage: data.max > 0 ? Math.round((data.earned / data.max) * 100) : 0,
    });
  }

  return scores;
}
