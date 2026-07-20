import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { readFile } from 'fs/promises';

export const maxDuration = 300; // combining/encoding can take a while

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { id: auditJobId } = await params;

    // Verify ownership
    const auditJob = await prisma.auditJob.findFirst({
      where: { id: auditJobId, userId: session.user.id },
    });

    if (!auditJob) {
      return NextResponse.json({ error: 'Audit job not found' }, { status: 404 });
    }

    const { buildVideoJourney } = await import('@/lib/video-journey');
    const result = await buildVideoJourney(auditJobId, auditJob.entityName);

    if (result.status === 'no-videos' || !result.absPath) {
      return NextResponse.json(
        { error: 'No recorded pillar videos found. Run a recorded pillar (1–5) first.' },
        { status: 409 }
      );
    }

    const videoBuffer = await readFile(result.absPath);
    const filename = `SiteCheck_VideoJourney_${auditJob.entityName.replace(/[^a-zA-Z0-9]/g, '_')}_${auditJobId.slice(0, 8)}.webm`;

    return new NextResponse(videoBuffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'video/webm',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': videoBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error('Video journey generation error:', error);
    return NextResponse.json(
      { error: 'Failed to build the combined video journey.' },
      { status: 500 }
    );
  }
}
