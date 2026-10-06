import type { certification } from '@a5/contracts';
import type { DbOrTrx } from '../database/index.js';
import { currentSignatures, currentStampImages } from '../common/artwork-repo.js';
import { signatureSlotOf } from '../rendering/layout.js';

/**
 * Would a certification still be issuable with this design? Signatories, signature images and the
 * stamp must exist for everything the design shows. Checked when a template is edited or assigned
 * so a design change can never make issuance start failing later.
 */
export async function artworkProblems(
  db: DbOrTrx,
  def: { id: string; name: string; stamp_id: string | null },
  design: certification.TemplateDesign,
): Promise<string[]> {
  const problems: string[] = [];
  const slots = await db
    .selectFrom('certification_signatory_slots as s')
    .innerJoin('signatories as g', 'g.id', 's.signatory_id')
    .select(['s.slot', 'g.id', 'g.name'])
    .where('s.definition_id', '=', def.id)
    .execute();
  const signatures = await currentSignatures(
    db,
    slots.map((s) => s.id),
  );
  for (const n of [1, 2] as const) {
    const showsSignature = design.elements.some(
      (el) => el.type === 'signature' && signatureSlotOf(el) === n,
    );
    const showsDetails = design.elements.some((el) => el.content.includes(`signatory_${n}_`));
    if (!showsSignature && !showsDetails) continue;
    const slot = slots.find((s) => s.slot === n);
    if (!slot)
      problems.push(`"${def.name}" has no signatory in slot ${n}, which the design shows.`);
    else if (showsSignature && !signatures.get(slot.id))
      problems.push(
        `${slot.name} has no signature image, which the design shows for "${def.name}".`,
      );
  }
  if (design.elements.some((el) => el.type === 'stamp')) {
    if (!def.stamp_id) problems.push(`"${def.name}" has no stamp, which the design shows.`);
    else if (!(await currentStampImages(db, [def.stamp_id])).get(def.stamp_id))
      problems.push(`The stamp of "${def.name}" has no image, which the design shows.`);
  }
  return problems;
}
