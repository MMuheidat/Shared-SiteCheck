import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: auditJobId } = await params;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes
      const POLL_INTERVAL_MS = 2000;
      const startTime = Date.now();
      let sentResultCount = 0;

      const sendEvent = (data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const poll = async () => {
        while (!closed) {
          // Check timeout
          if (Date.now() - startTime > MAX_DURATION_MS) {
            sendEvent({ type: 'timeout', message: 'Stream timed out after 10 minutes' });
            closed = true;
            break;
          }

          try {
            // Fetch the audit job with results
            const auditJob = await prisma.auditJob.findUnique({
              where: { id: auditJobId },
              include: {
                results: {
                  orderBy: { qid: 'asc' },
                },
              },
            });

            if (!auditJob) {
              sendEvent({ type: 'error', message: 'Audit job not found' });
              closed = true;
              break;
            }

            // Send any new results
            const currentResults = auditJob.results;
            if (currentResults.length > sentResultCount) {
              const newResults = currentResults.slice(sentResultCount);
              for (const result of newResults) {
                sendEvent({
                  type: 'criterion_complete',
                  qid: result.qid,
                  status: result.status,
                  criterionName: result.criterionNameEN,
                  scoreEarned: result.scoreEarned,
                  maxScore: result.maxScore,
                  pillar: result.pillar,
                  progress: Math.round(
                    (currentResults.indexOf(result) + 1) / Math.max(currentResults.length, 1) * 100
                  ),
                  totalChecked: sentResultCount + newResults.indexOf(result) + 1,
                });
              }
              sentResultCount = currentResults.length;
            }

            // Check if audit is complete or failed
            if (auditJob.status === 'complete' || auditJob.status === 'failed') {
              sendEvent({
                type: 'audit_complete',
                status: auditJob.status,
                totalScore: auditJob.totalScore,
                maxScore: auditJob.maxScore,
                percentage: auditJob.percentage,
                grade: auditJob.grade,
                totalCriteria: currentResults.length,
              });
              closed = true;
              break;
            }
          } catch (error) {
            console.error('SSE poll error:', error);
            sendEvent({ type: 'error', message: 'Error polling audit status' });
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      };

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        closed = true;
      });

      // Start polling
      void poll();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
