import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { readFile } from 'fs/promises';
import path from 'path';

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

    const { id: auditJobId } = await params;

    // Verify ownership
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

    // Generate the PDF
    const { generatePDF } = await import('@/lib/pdf-generator');
    const filePath = await generatePDF(auditJobId);

    // Read the file
    const absolutePath = path.join(/* turbopackIgnore: true */ process.cwd(), filePath);
    const pdfBuffer = await readFile(absolutePath);

    // Return as PDF download
    const filename = `SiteCheck_Report_${auditJob.entityName.replace(/[^a-zA-Z0-9]/g, '_')}_${auditJobId.slice(0, 8)}.pdf`;

    return new NextResponse(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': pdfBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error('PDF generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate PDF report' },
      { status: 500 }
    );
  }
}
