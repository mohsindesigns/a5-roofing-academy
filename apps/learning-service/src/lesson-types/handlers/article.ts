import { learning } from '@a5/contracts';
import { defineLessonType } from '../types.js';

export const articleLesson = defineLessonType<learning.ArticleLessonConfig>({
  type: 'article',
  label: 'Article',
  configSchema: learning.articleLessonConfigSchema,
  completion: 'manual',
  learnerCompletion() {
    return { allowed: true, reason: 'Mark the article complete when you have read it.' };
  },
  completionHint() {
    return 'Read the article, then select "Mark complete".';
  },
  grant() {
    return null;
  },
  references() {
    return {};
  },
  publishIssues(lesson) {
    return lesson.body?.trim() ? [] : ['Write the article text before publishing.'];
  },
});
