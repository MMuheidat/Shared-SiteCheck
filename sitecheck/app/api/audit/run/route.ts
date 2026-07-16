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
    const { auditJobId } = body;

    if (!auditJobId) {
      return NextResponse.json(
        { error: 'auditJobId is required' },
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

    if (auditJob.status === 'running') {
      return NextResponse.json(
        { error: 'Audit is already running' },
        { status: 409 }
      );
    }

    // Update status to running
    await prisma.auditJob.update({
      where: { id: auditJobId },
      data: { status: 'running' },
    });

    // Fire and forget — import the engine and run without awaiting
    import('@/lib/engine/index').then(({ runEvaluation }) => {
      void runEvaluation(auditJobId);
    }).catch((err) => {
      console.error('Failed to start evaluation engine:', err);
      // Update status to failed if engine can't even load
      prisma.auditJob.update({
        where: { id: auditJobId },
        data: { status: 'failed' },
      }).catch(console.error);
    });

    return NextResponse.json({ status: 'started' });
  } catch (error) {
    console.error('Run audit error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
