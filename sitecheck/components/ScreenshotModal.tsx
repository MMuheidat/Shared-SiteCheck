'use client';

import { useEffect, useCallback } from 'react';
import { X, ZoomIn, ExternalLink, Video } from 'lucide-react';

interface ScreenshotModalProps {
  isOpen: boolean;
  screenshotPath: string | null;
  criterionName: string;
  onClose: () => void;
}

export default function ScreenshotModal({ isOpen, screenshotPath, criterionName, onClose }: ScreenshotModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen || !screenshotPath) return null;

  const isVideo = screenshotPath.toLowerCase().endsWith('.webm') || screenshotPath.toLowerCase().endsWith('.mp4');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content p-0 relative" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            {isVideo ? <Video className="w-5 h-5 text-primary" /> : <ZoomIn className="w-5 h-5 text-primary" />}
            <h3 className="font-semibold text-text-primary text-sm truncate max-w-md">
              {criterionName}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={screenshotPath}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost text-xs"
            >
              <ExternalLink className="w-4 h-4" />
              Open
            </a>
            <button onClick={onClose} className="btn-ghost p-2">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Evidence (screen recording or screenshot) */}
        <div className="p-4 flex items-center justify-center bg-surface-darker min-h-[300px]">
          {isVideo ? (
            <video
              src={screenshotPath}
              controls
              autoPlay
              muted
              className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-lg"
            />
          ) : (
            <img
              src={screenshotPath}
              alt={`Screenshot: ${criterionName}`}
              className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-lg"
            />
          )}
        </div>
      </div>
    </div>
  );
}
