import { learning } from '@a5/contracts';
import { defineLessonType, type LessonTypeHandler } from '../types.js';

type DocumentConfig = learning.DocumentLessonConfig;

/** PDF and document lessons: the learner opens the file, then confirms they reviewed it. */
function documentLessonType(type: 'pdf' | 'document', label: string): LessonTypeHandler<DocumentConfig> {
  return defineLessonType<DocumentConfig>({
    type,
    label,
    configSchema: learning.documentLessonConfigSchema,
    completion: 'manual',
    learnerCompletion(_config, { progress }) {
      return progress?.startedAt
        ? { allowed: true, reason: 'Mark the document complete when you have reviewed it.' }
        : { allowed: false, reason: 'Open the document before marking it complete.' };
    },
    completionHint() {
      return 'Open the document, review it, then select "Mark complete".';
    },
    grant(config) {
      return { resource: { type: 'document', id: config.mediaAssetId }, policy: { allowDownload: config.allowDownload } };
    },
    references(config) {
      return { mediaAssetIds: [config.mediaAssetId] };
    },
  });
}

export const pdfLesson = documentLessonType('pdf', 'PDF');
export const documentLesson = documentLessonType('document', 'Document');
