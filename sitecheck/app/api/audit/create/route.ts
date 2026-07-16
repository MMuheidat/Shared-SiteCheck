import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { websiteUrl, entityName, serviceName, evaluatorLanguage, deviceType } = body;

    // Validate required fields
    if (!websiteUrl || !entityName) {
      return NextResponse.json(
        { error: 'websiteUrl and entityName are required' },
        { status: 400 }
      );
    }

    // Validate URL format
    try {
      new URL(websiteUrl);
    } catch {
      return NextResponse.json(
        { error: 'Invalid website URL format' },
        { status: 400 }
      );
    }

    const auditJob = await prisma.auditJob.create({
      data: {
        userId: session.user.id,
        websiteUrl,
        entityName,
        serviceName: serviceName || '',
        evaluatorLanguage: evaluatorLanguage || 'en',
        deviceType: deviceType || 'desktop',
        status: 'pending',
      },
    });

    return NextResponse.json({ id: auditJob.id }, { status: 201 });
  } catch (error) {
    console.error('Create audit error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
