import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    const auditJob = await prisma.auditJob.findFirst({
      where: {
        id,
        userId: session.user.id,
      },
      include: {
        results: {
          orderBy: { qid: 'asc' },
        },
        pdfReports: true,
      },
    });

    if (!auditJob) {
      return NextResponse.json(
        { error: 'Audit job not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(auditJob);
  } catch (error) {
    console.error('Get audit error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Verify ownership
    const auditJob = await prisma.auditJob.findFirst({
      where: {
        id,
        userId: session.user.id,
      },
    });

    if (!auditJob) {
      return NextResponse.json(
        { error: 'Audit job not found' },
        { status: 404 }
      );
    }

    // Delete in order: results and reports cascade via onDelete, but let's be explicit
    await prisma.criterionResult.deleteMany({ where: { auditJobId: id } });
    await prisma.pdfReport.deleteMany({ where: { auditJobId: id } });
    await prisma.auditJob.delete({ where: { id } });

    return NextResponse.json({ success: true, message: 'Audit job deleted' });
  } catch (error) {
    console.error('Delete audit error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
