import Link from 'next/link';
import {
  Shield,
  CheckCircle,
  Camera,
  Languages,
  FileDown,
  ArrowRight,
  Globe,
  BarChart3,
  Sparkles,
  Zap,
  Target,
  FileText,
} from 'lucide-react';

const features = [
  {
    icon: CheckCircle,
    title: 'Automated Checks',
    description: 'All 35+ criteria checked automatically using intelligent browser analysis.',
    color: 'text-success',
    bg: 'bg-emerald-50',
  },
  {
    icon: Camera,
    title: 'Evidence Screenshots',
    description: 'Automatic screenshots captured as proof for every criterion evaluated.',
    color: 'text-info',
    bg: 'bg-blue-50',
  },
  {
    icon: Languages,
    title: 'Bilingual Support',
    description: 'Full Arabic and English support with RTL-aware evaluation engine.',
    color: 'text-primary',
    bg: 'bg-primary-50',
  },
  {
    icon: FileDown,
    title: 'PDF Export',
    description: 'Download comprehensive PDF reports ready for official submission.',
    color: 'text-accent',
    bg: 'bg-amber-50',
  },
];

const stats = [
  { value: '10', label: 'Pillars', icon: Target },
  { value: '35+', label: 'Checks', icon: Zap },
  { value: '118', label: 'Points', icon: BarChart3 },
  { value: 'Bilingual', label: 'Reports', icon: FileText },
];

const steps = [
  {
    step: '01',
    title: 'Enter Website URL',
    description: 'Provide the government website URL and entity details to begin the evaluation.',
    icon: Globe,
  },
  {
    step: '02',
    title: 'Automated Analysis',
    description: 'Our engine navigates your site, evaluating all 10 pillars against official criteria.',
    icon: Sparkles,
  },
  {
    step: '03',
    title: 'Download Report',
    description: 'Review detailed scores, evidence screenshots, and download the full PDF report.',
    icon: FileDown,
  },
];

export default function HomePage() {
  return (
    <div className="overflow-hidden">
      {/* ====== HERO ====== */}
      <section className="gradient-hero-mesh relative min-h-[85vh] flex items-center justify-center px-4">
        {/* Floating dots */}
        <div className="hero-dot" style={{ top: '15%', left: '10%' }} />
        <div className="hero-dot" style={{ top: '25%', right: '15%', width: '6px', height: '6px' }} />
        <div className="hero-dot" style={{ bottom: '30%', left: '20%', width: '3px', height: '3px' }} />
        <div className="hero-dot" style={{ top: '60%', right: '25%' }} />
        <div className="hero-dot" style={{ bottom: '20%', right: '10%', width: '5px', height: '5px' }} />

        {/* Decorative rings */}
        <div className="absolute top-20 right-20 w-64 h-64 border border-white/5 rounded-full hidden lg:block" />
        <div className="absolute top-28 right-28 w-48 h-48 border border-white/10 rounded-full hidden lg:block" />
        <div className="absolute -bottom-16 -left-16 w-72 h-72 bg-primary-light/10 rounded-full blur-3xl" />

        <div className="relative max-w-5xl mx-auto text-center z-10">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white/90 text-sm font-medium mb-8 animate-fade-in">
            <Shield className="w-4 h-4" />
            UAE Government Website Standards
          </div>

          {/* Title */}
          <h1 className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold text-white leading-tight mb-6 animate-slide-up">
            Automated UAE
            <br />
            <span className="bg-gradient-to-r from-white via-primary-100 to-primary-200 bg-clip-text text-transparent">
              Government Website
            </span>
            <br />
            Evaluation
          </h1>

          {/* Subtitle */}
          <p className="text-lg sm:text-xl text-white/70 max-w-2xl mx-auto mb-10 leading-relaxed animate-slide-up" style={{ animationDelay: '100ms' }}>
            Powered by the official evaluation framework —{' '}
            <span className="text-white font-semibold">10 pillars</span>,{' '}
            <span className="text-white font-semibold">118 scoring points</span>
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-slide-up" style={{ animationDelay: '200ms' }}>
            <Link
              href="/audit/new"
              className="btn-primary text-base px-8 py-4 shadow-xl shadow-primary-dark/30 hover:shadow-2xl"
            >
              Start New Evaluation
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl text-white/90 border border-white/20 hover:bg-white/10 transition-all font-semibold text-base"
            >
              View Dashboard
            </Link>
          </div>
        </div>
      </section>

      {/* ====== STATS BAR ====== */}
      <section className="relative -mt 0 z-20 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="glass rounded-2xl p-6 sm:p-8 shadow-xl">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
              {stats.map((stat) => (
                <div key={stat.label} className="text-center group">
                  <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-primary-50 text-primary mb-3 group-hover:scale-110 transition-transform">
                    <stat.icon className="w-5 h-5" />
                  </div>
                  <div className="text-2xl sm:text-3xl font-bold text-text-primary">{stat.value}</div>
                  <div className="text-sm text-text-muted mt-1">{stat.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ====== FEATURES ====== */}
      <section className="py-24 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-text-primary mb-4">
              Everything You Need
            </h2>
            <p className="text-lg text-text-secondary max-w-2xl mx-auto">
              A comprehensive toolkit designed to evaluate government websites against official UAE standards.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {features.map((feature, i) => (
              <div
                key={feature.title}
                className="card-elevated p-6 group cursor-default animate-slide-up"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <div className={`w-12 h-12 rounded-xl ${feature.bg} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                  <feature.icon className={`w-6 h-6 ${feature.color}`} />
                </div>
                <h3 className="text-lg font-semibold text-text-primary mb-2">{feature.title}</h3>
                <p className="text-sm text-text-secondary leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== HOW IT WORKS ====== */}
      <section className="py-24 px-4 bg-gradient-to-b from-surface-dark to-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-text-primary mb-4">
              How It Works
            </h2>
            <p className="text-lg text-text-secondary max-w-2xl mx-auto">
              Three simple steps to a complete website evaluation.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {steps.map((step, i) => (
              <div key={step.step} className="relative animate-slide-up" style={{ animationDelay: `${i * 150}ms` }}>
                {/* Connector line */}
                {i < steps.length - 1 && (
                  <div className="hidden md:block absolute top-12 left-[60%] w-[80%] border-t-2 border-dashed border-border" />
                )}
                <div className="card-elevated p-8 text-center relative z-10">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary-light text-white text-lg font-bold mb-5 shadow-lg shadow-primary/20">
                    {step.step}
                  </div>
                  <h3 className="text-lg font-semibold text-text-primary mb-3">{step.title}</h3>
                  <p className="text-sm text-text-secondary leading-relaxed">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== CTA BOTTOM ====== */}
      <section className="py-24 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <div className="gradient-hero-mesh rounded-3xl p-12 sm:p-16 relative overflow-hidden">
            <div className="hero-dot" style={{ top: '10%', left: '5%' }} />
            <div className="hero-dot" style={{ bottom: '15%', right: '8%', width: '5px', height: '5px' }} />
            <div className="relative z-10">
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
                Ready to Evaluate?
              </h2>
              <p className="text-lg text-white/70 mb-8 max-w-xl mx-auto">
                Start your first automated evaluation in under a minute.
              </p>
              <Link
                href="/audit/new"
                className="inline-flex items-center gap-2 bg-white text-primary font-semibold px-8 py-4 rounded-xl hover:bg-white/90 transition-all shadow-xl text-base"
              >
                Get Started
                <ArrowRight className="w-5 h-5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ====== FOOTER ====== */}
      <footer className="border-t border-border py-8 px-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <Shield className="w-4 h-4 text-primary" />
            <span>SiteCheck — UAE Government Website Evaluation Tool</span>
          </div>
          <div className="text-sm text-text-muted">
            © {new Date().getFullYear()} All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
