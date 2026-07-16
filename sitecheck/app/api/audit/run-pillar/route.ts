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
    const { auditJobId, pillarName } = body;

    if (!auditJobId) {
      return NextResponse.json(
        { error: 'auditJobId is required' },
        { status: 400 }
      );
    }

    if (!pillarName) {
      return NextResponse.json(
        { error: 'pillarName is required' },
        { status: 400 }
      );
    }

    // Verify the audit job exists and belongs to the user
    const auditJob = await prisma.auditJob.findFirst({
      where: {
        id: auditJobId,
        userId: session.user.id,
      },
    });

    if (!auditJob) {
      return NextResponse.json(
        { error: 'Audit job not found' },
        { status: 404 }
      );
    }

    // Fire and forget — import the engine and run the single pillar
    import('@/lib/engine/index').then(({ runSinglePillar }) => {
      void runSinglePillar(auditJobId, pillarName).then((result) => {
        console.log(`[SiteCheck] Single pillar run complete:`, result);
      });
    }).catch((err) => {
      console.error('Failed to start single pillar evaluation:', err);
    });

    return NextResponse.json({ status: 'started', pillarName });
  } catch (error) {
    console.error('Run pillar error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
