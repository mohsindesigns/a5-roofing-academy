import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import { InjectDb, NotFoundError } from '@a5/nest-kit';
import type { ObjectStorage } from '@a5/storage';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { assertDesignAssets, assetsByIds, currentSignatures, currentStampImages, inEffect } from '../common/artwork-repo.js';
import { calendarDate, computeExpiry } from '../common/dates.js';
import { canonicalJson } from '../common/json.js';
import { loadSettings, organizationCode } from '../common/settings.js';
import { InjectStorage, storageKeys } from '../common/storage.js';
import { CSS_FONTS, cssFontWeight, elementFontFamily, elementText, pageSize, signatureSlotOf } from '../rendering/layout.js';
import { renderCertificatePdf } from '../rendering/renderer.js';
import { placeholderValues } from '../rendering/values.js';
import { TemplatesService } from './templates.service.js';

type TemplateDesign = certification.TemplateDesign;

const SAMPLE_RECIPIENT = { name: 'Jordan Ellis', employeeId: 'A5-1042' };

/**
 * Template previews: a watermarked PDF rendered with sample data plus the resolved element list the
 * web designer uses for its live HTML preview (same percent geometry as the PDF).
 */
@Injectable()
export class PreviewService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectStorage() private readonly storage: ObjectStorage,
    private readonly templates: TemplatesService,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
  ) {}

  async preview(p: Principal, templateId: string, input: { design?: TemplateDesign; certificationId?: string }) {
    const template = await this.db
      .selectFrom('certificate_templates')
      .select(['id', 'name'])
      .where('id', '=', templateId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!template) throw new NotFoundError('Certificate template');
    const design = input.design ?? (await this.templates.currentVersion(this.db, templateId)).design;
    await assertDesignAssets(this.db, p.organizationId, design);
    return this.render(p.organizationId, design, input.certificationId ?? null);
  }

  private async render(organizationId: string, design: TemplateDesign, certificationId: string | null) {
    const warnings: string[] = [];
    const settings = await loadSettings(this.db, organizationId, this.config.publicAppUrl);
    const definition = certificationId
      ? await this.db
          .selectFrom('certification_definitions')
          .selectAll()
          .where('id', '=', certificationId)
          .where('organization_id', '=', organizationId)
          .executeTakeFirst()
      : await this.db
          .selectFrom('certification_definitions')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('status', '=', 'active')
          .orderBy('created_at')
          .executeTakeFirst();
    if (certificationId && !definition) throw new NotFoundError('Certification');

    const now = new Date();
    const today = calendarDate(now, settings.timezone);
    const programs = definition
      ? await this.db
          .selectFrom('certification_programs as cp')
          .leftJoin('program_catalog as pc', 'pc.program_id', 'cp.program_id')
          .select(['pc.title'])
          .where('cp.definition_id', '=', definition.id)
          .execute()
      : [];

    // Signatories: the certification's slots, else the first active signatories of the organization.
    let slots: Array<{ slot: number; id: string; name: string; title: string }> = [];
    if (definition) {
      slots = await this.db
        .selectFrom('certification_signatory_slots as s')
        .innerJoin('signatories as g', 'g.id', 's.signatory_id')
        .select(['s.slot', 'g.id', 'g.name', 'g.title'])
        .where('s.definition_id', '=', definition.id)
        .orderBy('s.slot')
        .execute();
    }
    if (slots.length === 0) {
      const rows = await this.db
        .selectFrom('signatories')
        .select(['id', 'name', 'title', 'active', 'effective_from', 'effective_to'])
        .where('organization_id', '=', organizationId)
        .where('active', '=', true)
        .orderBy('name')
        .execute();
      slots = rows.filter((r) => inEffect(r, today)).slice(0, 2).map((r, i) => ({ slot: i + 1, id: r.id, name: r.name, title: r.title }));
    }
    const signatures = await currentSignatures(this.db, slots.map((s) => s.id));
    let stampId = definition?.stamp_id ?? null;
    if (!stampId) {
      const stamp = await this.db
        .selectFrom('stamps')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('active', '=', true)
        .orderBy((eb) => eb.case().when('kind', '=', 'company').then(0).else(1).end())
        .orderBy('name')
        .executeTakeFirst();
      stampId = stamp?.id ?? null;
    }
    const stampImage = stampId ? (await currentStampImages(this.db, [stampId])).get(stampId) ?? null : null;
    const assets = await assetsByIds(this.db, organizationId, certification.designAssetIds(design));

    const usesSlot = (n: 1 | 2) => design.elements.some((el) => el.type === 'signature' && signatureSlotOf(el) === n);
    for (const n of [1, 2] as const) {
      const slot = slots.find((s) => s.slot === n);
      if (usesSlot(n) && !slot) warnings.push(`The design shows signatory ${n}, but no signatory is assigned.`);
      else if (usesSlot(n) && slot && !signatures.get(slot.id)) warnings.push(`${slot.name} has no signature image yet.`);
    }
    if (design.elements.some((el) => el.type === 'stamp') && !stampImage) warnings.push('The design shows a stamp, but no stamp image is available.');

    const customValues: Record<string, string> = {};
    for (const v of definition?.custom_variables ?? []) customValues[v.key] = v.value;
    for (const key of certification.customPlaceholdersOf(design)) {
      if (customValues[key] === undefined) {
        customValues[key] = `[${key}]`;
        warnings.push(`{{${key}}} is not a built-in placeholder; define it as a custom variable on the certification.`);
      }
    }

    const sequence = definition
      ? Number(
          (
            await this.db
              .selectFrom('certificate_number_sequences')
              .select('last_value')
              .where('definition_id', '=', definition.id)
              .executeTakeFirst()
          )?.last_value ?? 0,
        ) + 1
      : 1;
    const certificateNumber = definition
      ? certification.formatCertificateNumber(definition.number_pattern, {
          org: organizationCode(settings, definition.issuing_organization_name),
          code: definition.code,
          issuedAt: now,
          seq: sequence,
        })
      : certification.formatCertificateNumber(certification.DEFAULT_NUMBER_PATTERN, { org: 'ORG', code: 'CERT', issuedAt: now, seq: 1 });
    const verificationUrl = `${settings.effectiveVerificationBaseUrl}/verify/SAMPLE-PREVIEW`;
    const values = placeholderValues({
      certificateName: definition?.name ?? 'Certified Sales Professional',
      recipientName: SAMPLE_RECIPIENT.name,
      employeeId: SAMPLE_RECIPIENT.employeeId,
      programNames: programs.map((r) => r.title).filter((t): t is string => Boolean(t)),
      completionDate: now,
      issuedAt: now,
      expiresAt: definition ? computeExpiry(definition.validity_policy, now) : null,
      certificateNumber,
      verificationUrl,
      organizationName: definition?.issuing_organization_name ?? 'Issuing organization',
      signatories: slots.map((s) => ({ slot: s.slot, name: s.name, title: s.title })),
      customVariables: customValues,
      timezone: settings.timezone,
    });
    if (!values.program_name) values.program_name = 'New Hire Sales Academy';

    const imageKey = (n: 1 | 2) => {
      const slot = slots.find((s) => s.slot === n);
      return slot ? (signatures.get(slot.id)?.asset.storage_key ?? null) : null;
    };
    const load = async (key: string | null) => (key ? this.storage.getBytes(key) : null);
    const [signature1, signature2, stamp, assetBuffers] = await Promise.all([
      load(imageKey(1)),
      load(imageKey(2)),
      load(stampImage?.asset.storage_key ?? null),
      Promise.all([...assets.values()].map(async (a) => [a.id, await this.storage.getBytes(a.storage_key)] as const)),
    ]);

    const hash = createHash('sha256')
      .update(canonicalJson({ design, values, keys: [imageKey(1), imageKey(2), stampImage?.asset.storage_key, [...assets.keys()]] }))
      .digest('hex');
    const pdfKey = storageKeys.preview(organizationId, hash);
    if (!(await this.storage.headObject(pdfKey))) {
      const pdf = await renderCertificatePdf({
        design,
        values,
        qrValue: verificationUrl,
        images: { signature1, signature2, stamp, assets: new Map(assetBuffers) },
        info: { title: 'Certificate preview', author: values.organization_name ?? '', subject: 'Sample data', keywords: 'preview', creationDate: now },
        footer: 'Preview with sample data - not a valid certificate',
        watermark: 'PREVIEW',
      });
      await this.storage.putObject(pdfKey, pdf, { contentType: 'application/pdf', contentLength: pdf.length });
    }
    const ttl = this.config.certification.previewUrlTtlSeconds;
    const sign = (key: string | null | undefined) => (key ? this.storage.signedGetUrl(key, { expiresInSeconds: ttl }) : Promise.resolve(null));
    const page = pageSize(design);
    const elements = await Promise.all(
      design.elements.map(async (el) => {
        const family = elementFontFamily(el, design);
        let imageUrl: string | null = null;
        if (el.type === 'signature') imageUrl = await sign(imageKey(signatureSlotOf(el)));
        else if (el.type === 'stamp') imageUrl = await sign(stampImage?.asset.storage_key);
        else if ((el.type === 'image' || el.type === 'logo') && el.assetId) imageUrl = await sign(assets.get(el.assetId)?.storage_key);
        return {
          id: el.id,
          type: el.type,
          x: el.x,
          y: el.y,
          width: el.width,
          height: el.height,
          text: el.type === 'text' ? elementText(el, values) : null,
          imageUrl,
          qrValue: el.type === 'qr' ? verificationUrl : null,
          align: el.align,
          fontSize: el.fontSize,
          fontWeight: cssFontWeight(family, el.fontWeight),
          fontStyle: el.fontStyle,
          fontFamily: family,
          cssFontFamily: CSS_FONTS[family],
          color: el.color,
          letterSpacing: el.letterSpacing,
          uppercase: el.uppercase,
          lineHeight: el.lineHeight,
          strokeWidth: el.strokeWidth,
        };
      }),
    );
    return {
      pdfUrl: await this.storage.signedGetUrl(pdfKey, { expiresInSeconds: ttl, downloadName: 'certificate-preview.pdf' }),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      page: { size: design.page.size, orientation: design.page.orientation, widthPt: page.width, heightPt: page.height },
      theme: {
        ...design.theme,
        backgroundImageUrl: await sign(design.theme.backgroundImageAssetId ? assets.get(design.theme.backgroundImageAssetId)?.storage_key : null),
      },
      elements,
      sampleValues: values,
      warnings,
    };
  }
}
