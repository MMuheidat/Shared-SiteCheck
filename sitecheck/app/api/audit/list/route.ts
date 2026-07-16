import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const audits = await prisma.auditJob.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        websiteUrl: true,
        entityName: true,
        serviceName: true,
        evaluatorLanguage: true,
        deviceType: true,
        status: true,
        totalScore: true,
        maxScore: true,
        percentage: true,
        grade: true,
        createdAt: true,
      },
    });

    return NextResponse.json(audits);
  } catch (error) {
    console.error('List audits error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
