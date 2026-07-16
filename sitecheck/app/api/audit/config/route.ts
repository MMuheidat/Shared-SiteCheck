import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const serpApiConfigured = Boolean(process.env.SERPAPI_KEY?.trim());
  const googlePlacesConfigured = Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());

  return NextResponse.json({
    serpApiConfigured,
    googlePlacesConfigured,
    warnings: [
      !serpApiConfigured ? '⚠️ Google Search API key not configured. Q1 and Q1b will be skipped.' : null,
      !googlePlacesConfigured ? '⚠️ Google Places API key not configured. Q3 will be skipped.' : null,
    ].filter(Boolean),
  });
}
