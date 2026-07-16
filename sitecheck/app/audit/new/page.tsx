'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import {
  Globe,
  Building2,
  Briefcase,
  Languages,
  Monitor,
  Play,
  Loader2,
  Shield,
  AlertTriangle,
  Tag,
} from 'lucide-react';
import { useToast } from '@/components/Toast';

export default function NewAuditPage() {
  const { status } = useSession();
  const router = useRouter();
  const { showToast } = useToast();

  const [websiteUrl, setWebsiteUrl] = useState('');
  const [entityName, setEntityName] = useState('');
  const [acronym, setAcronym] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [language, setLanguage] = useState('en');
  const [deviceType, setDeviceType] = useState('desktop');
  const [loading, setLoading] = useState(false);
  const [configWarnings, setConfigWarnings] = useState<string[]>([]);

  useEffect(() => {
    // Disabled redirect to bypass login
  }, [status, router]);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res = await fetch('/api/audit/config');
        if (!res.ok) return;

        const data = await res.json() as {
          serpApiConfigured: boolean;
          googlePlacesConfigured: boolean;
        };

        const warnings: string[] = [];
        if (!data.serpApiConfigured) {
          warnings.push('⚠️ Google Search API key not configured. Q1 and Q1b will be skipped.');
        }
        if (!data.googlePlacesConfigured) {
          warnings.push('⚠️ Google Places API key not configured. Q3 will be skipped.');
        }
        setConfigWarnings(warnings);
      } catch {
        setConfigWarnings([]);
      }
    };

    loadConfig();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Create the audit (don't auto-run — user will run pillars individually)
      const createRes = await fetch('/api/audit/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          websiteUrl,
          entityName,
          acronym,
          serviceName,
          evaluatorLanguage: language,
          deviceType,
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.json();
        throw new Error(err.error || 'Failed to create audit');
      }

      const { id } = await createRes.json();

      showToast('Audit created! Run each pillar individually.', 'success');

      // Redirect to results page where individual pillar buttons are shown
      router.push(`/audit/${id}/results`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred';
      showToast(message, 'error');
      setLoading(false);
    }
  };

  if (status === 'loading') {
    return null;
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12">
      <div className="animate-fade-in">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary-light text-white mb-4 shadow-lg shadow-primary/20">
            <Shield className="w-7 h-7" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">New Website Evaluation</h1>
          <p className="text-text-secondary mt-2 max-w-md mx-auto">
            Enter the details below to begin an automated website evaluation.
          </p>
        </div>

        {/* Form Card */}
        <div className="card-elevated p-6 sm:p-8">


          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Website URL */}
            <div>
              <label htmlFor="url" className="label">
                <div className="flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-text-muted" />
                  Website URL <span className="text-danger">*</span>
                </div>
              </label>
              <input
                id="url"
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                className="input"
                placeholder="https://www.example.gov.ae"
                required
              />
              <p className="text-xs text-text-muted mt-1.5">Enter the full URL including https://</p>
            </div>

            {/* Entity Name */}
            <div>
              <label htmlFor="entity" className="label">
                <div className="flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-text-muted" />
                  Government Entity Name <span className="text-danger">*</span>
                </div>
              </label>
              <input
                id="entity"
                type="text"
                value={entityName}
                onChange={(e) => setEntityName(e.target.value)}
                className="input"
                placeholder="e.g., Ministry of Education"
                required
              />
            </div>

            {/* Entity Acronym */}
            <div>
              <label htmlFor="acronym" className="label">
                <div className="flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5 text-text-muted" />
                  Entity Acronym <span className="text-text-muted font-normal">(optional)</span>
                </div>
              </label>
              <input
                id="acronym"
                type="text"
                value={acronym}
                onChange={(e) => setAcronym(e.target.value)}
                className="input"
                placeholder="e.g., TAMM, ADEO"
              />
              <p className="text-xs text-text-muted mt-1.5">
                Used for the acronym search check (Q1b). Leave empty to derive it automatically from the entity name.
              </p>
            </div>

            {/* Service Name */}
            <div>
              <label htmlFor="service" className="label">
                <div className="flex items-center gap-1.5">
                  <Briefcase className="w-3.5 h-3.5 text-text-muted" />
                  Assessed Service Name <span className="text-text-muted font-normal">(optional)</span>
                </div>
              </label>
              <input
                id="service"
                type="text"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                className="input"
                placeholder="e.g., Student Portal"
              />
            </div>

            {/* Two-column row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {/* Language */}
              <div>
                <label htmlFor="language" className="label">
                  <div className="flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-text-muted" />
                    Evaluator Language
                  </div>
                </label>
                <select
                  id="language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="select"
                >
                  <option value="en">English</option>
                  <option value="ar">Arabic</option>
                </select>
              </div>

              {/* Device Type */}
              <div>
                <label htmlFor="device" className="label">
                  <div className="flex items-center gap-1.5">
                    <Monitor className="w-3.5 h-3.5 text-text-muted" />
                    Device Type
                  </div>
                </label>
                <select
                  id="device"
                  value={deviceType}
                  onChange={(e) => setDeviceType(e.target.value)}
                  className="select"
                >
                  <option value="desktop">Desktop</option>
                  <option value="smartphone">Smartphone</option>
                  <option value="tablet">Tablet</option>
                </select>
              </div>
            </div>

            {/* Submit */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full py-3.5 text-base"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Creating Audit...
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5" />
                    Create Audit
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
