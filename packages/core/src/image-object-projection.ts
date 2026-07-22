import type { HybridAlignmentUnit, HybridChildProjection } from "./hybrid-alignment-v2";
import type { PdfGeometryObject, PdfTextGeometry } from "./pdf-geometry";
import type { PdfRegion } from "./pdf-source-map";

export const PDF_ASSET_REGION_POLICY = {
  version: "pdf_asset_region_policy.v1",
  row_tolerance: 6,
  caption_max_vertical_gap_page_ratio: 0.12,
  caption_min_horizontal_overlap_ratio: 0.5,
} as const;

interface OrderedLeaf {
  index: number;
  unit_id: string;
  child: HybridAlignmentUnit["child_lids"][number];
}

interface ProjectionAnchor {
  index: number;
  region: PdfRegion;
}

function centerY(region: Pick<PdfRegion, "bbox">): number {
  return (region.bbox[1] + region.bbox[3]) / 2;
}

function documentOrder(
  left: Pick<PdfRegion, "pageIndex" | "bbox">,
  right: Pick<PdfRegion, "pageIndex" | "bbox">,
): number {
  if (left.pageIndex !== right.pageIndex) return left.pageIndex - right.pageIndex;
  const yDifference = centerY(right) - centerY(left);
  if (Math.abs(yDifference) > PDF_ASSET_REGION_POLICY.row_tolerance) return yDifference;
  return left.bbox[0] - right.bbox[0] || left.bbox[2] - right.bbox[2];
}

function orderedObjects(geometry: PdfTextGeometry): PdfGeometryObject[] {
  return geometry.pages
    .flatMap((page) => page.objects ?? [])
    .sort((left, right) => documentOrder(left, right) || left.objectIndex - right.objectIndex);
}

function projectionRegions(projection: HybridChildProjection): PdfRegion[] {
  const regions = projection.regions.length
    ? projection.regions
    : projection.primary_region ? [projection.primary_region] : [];
  return [...regions].sort(documentOrder);
}

function anchorAt(
  leaves: OrderedLeaf[],
  projections: Map<string, HybridChildProjection>,
  start: number,
  step: -1 | 1,
): ProjectionAnchor | null {
  for (let index = start; index >= 0 && index < leaves.length; index += step) {
    const leaf = leaves[index];
    if (leaf.child.kind === "image") continue;
    const projection = projections.get(leaf.child.lid);
    if (!projection || projection.precision === "unmapped") continue;
    const regions = projectionRegions(projection);
    const region = step === -1 ? regions.at(-1) : regions[0];
    if (region) return { index, region };
  }
  return null;
}

function objectBetweenAnchors(
  object: PdfGeometryObject,
  previous: ProjectionAnchor,
  next: ProjectionAnchor,
): boolean {
  if (previous.region.pageIndex !== next.region.pageIndex) {
    return object.pageIndex === next.region.pageIndex && documentOrder(object, next.region) < 0;
  }
  return object.pageIndex === previous.region.pageIndex
    && documentOrder(previous.region, object) < 0
    && documentOrder(object, next.region) < 0;
}

function horizontalOverlapRatio(
  left: Pick<PdfRegion, "bbox">,
  right: Pick<PdfRegion, "bbox">,
): number {
  const overlap = Math.max(0, Math.min(left.bbox[2], right.bbox[2]) - Math.max(left.bbox[0], right.bbox[0]));
  const narrower = Math.min(left.bbox[2] - left.bbox[0], right.bbox[2] - right.bbox[0]);
  return narrower > 0 ? overlap / narrower : 0;
}

function sameObjectRow(left: PdfGeometryObject, right: PdfGeometryObject): boolean {
  if (left.pageIndex !== right.pageIndex) return false;
  const overlap = Math.max(0, Math.min(left.bbox[3], right.bbox[3]) - Math.max(left.bbox[1], right.bbox[1]));
  const shorter = Math.min(left.bbox[3] - left.bbox[1], right.bbox[3] - right.bbox[1]);
  return Math.abs(centerY(left) - centerY(right)) <= PDF_ASSET_REGION_POLICY.row_tolerance
    || (shorter > 0 && overlap / shorter >= 0.5);
}

function captionCandidates(
  geometry: PdfTextGeometry,
  objects: PdfGeometryObject[],
  caption: ProjectionAnchor,
): PdfGeometryObject[] {
  const page = geometry.pages.find((candidate) => candidate.pageIndex === caption.region.pageIndex);
  if (!page) return [];
  const maxGap = page.height * PDF_ASSET_REGION_POLICY.caption_max_vertical_gap_page_ratio;
  return objects.filter((object) => {
    if (object.pageIndex !== caption.region.pageIndex) return false;
    const verticalGap = object.bbox[1] - caption.region.bbox[3];
    return verticalGap >= -PDF_ASSET_REGION_POLICY.row_tolerance
      && verticalGap <= maxGap
      && horizontalOverlapRatio(object, caption.region)
        >= PDF_ASSET_REGION_POLICY.caption_min_horizontal_overlap_ratio;
  });
}

function exactProjection(leaf: OrderedLeaf, object: PdfGeometryObject, reason: string): HybridChildProjection {
  const region: PdfRegion = {
    region_id: `${leaf.unit_id}-${leaf.child.lid}-asset-1`,
    pageIndex: object.pageIndex,
    bbox: [...object.bbox],
  };
  return {
    lid: leaf.child.lid,
    source_span: { ...leaf.child.source_span },
    precision: "region_exact",
    regions: [region],
    exact_source_spans: [],
    selection_assignments: [],
    primary_region: region,
    alignment: { unit_id: leaf.unit_id, reason: `asset_region_exact: ${reason}` },
  };
}

function unmappedProjection(leaf: OrderedLeaf, reason: string): HybridChildProjection {
  return {
    lid: leaf.child.lid,
    source_span: { ...leaf.child.source_span },
    precision: "unmapped",
    regions: [],
    exact_source_spans: [],
    selection_assignments: [],
    alignment: { unit_id: leaf.unit_id, reason: `asset_unmapped: ${reason}` },
  };
}

export function projectImageObjectRegions(
  units: HybridAlignmentUnit[],
  existingProjections: HybridChildProjection[],
  geometry: PdfTextGeometry,
): HybridChildProjection[] {
  const leaves: OrderedLeaf[] = units.flatMap((unit) => unit.child_lids.map((child) => ({
    index: 0,
    unit_id: unit.unit_id,
    child,
  }))).map((leaf, index) => ({ ...leaf, index }));
  const images = leaves.filter((leaf) => leaf.child.kind === "image");
  if (!images.length) return existingProjections;

  const projections = new Map(existingProjections.map((projection) => [projection.lid, projection]));
  const objects = orderedObjects(geometry);
  const claimedObjects = new Set<string>();
  const replacements = new Map<string, HybridChildProjection>();
  const replacementObjects = new Map<string, PdfGeometryObject>();
  const objectKey = (object: PdfGeometryObject) => `${object.pageIndex}:${object.objectIndex}`;
  const bind = (image: OrderedLeaf, object: PdfGeometryObject, reason: string) => {
    claimedObjects.add(objectKey(object));
    replacementObjects.set(image.child.lid, object);
    replacements.set(image.child.lid, exactProjection(image, object, reason));
  };

  const groups = new Map<string, { images: OrderedLeaf[]; previous: ProjectionAnchor; next: ProjectionAnchor }>();
  for (const image of images) {
    const previous = anchorAt(leaves, projections, image.index - 1, -1);
    const next = anchorAt(leaves, projections, image.index + 1, 1);
    if (!previous || !next) continue;
    const key = `${previous.index}:${next.index}`;
    const group = groups.get(key) ?? { images: [], previous, next };
    group.images.push(image);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const candidates = objects.filter((object) => (
      !claimedObjects.has(objectKey(object)) && objectBetweenAnchors(object, group.previous, group.next)
    ));
    if (candidates.length !== group.images.length) continue;
    group.images.forEach((image, index) => {
      bind(
        image,
        candidates[index],
        "unique PDF object chain inside proven source-order anchors",
      );
    });
  }

  for (const image of images.filter((candidate) => !replacements.has(candidate.child.lid))) {
    const nextImageIndex = images.find((candidate) => candidate.index > image.index)?.index ?? leaves.length;
    const caption = anchorAt(leaves, projections, image.index + 1, 1);
    const adjacentCaption = caption && caption.index < nextImageIndex ? caption : null;
    const candidates = adjacentCaption
      ? captionCandidates(geometry, objects.filter((object) => !claimedObjects.has(objectKey(object))), adjacentCaption)
      : [];
    if (candidates.length === 1) {
      bind(
        image,
        candidates[0],
        "unique same-page PDF object above an adjacent proven caption anchor",
      );
    }
  }

  const resolvedImageIndexes = images.flatMap((image, index) => (
    replacementObjects.has(image.child.lid) ? [index] : []
  ));
  for (let boundary = 1; boundary < resolvedImageIndexes.length; boundary += 1) {
    const previousIndex = resolvedImageIndexes[boundary - 1];
    const nextIndex = resolvedImageIndexes[boundary];
    const unresolved = images.slice(previousIndex + 1, nextIndex)
      .filter((image) => !replacements.has(image.child.lid));
    if (!unresolved.length) continue;
    const previousObject = replacementObjects.get(images[previousIndex].child.lid)!;
    const nextObject = replacementObjects.get(images[nextIndex].child.lid)!;
    if (!sameObjectRow(previousObject, nextObject)) continue;
    const candidates = objects.filter((object) => (
      !claimedObjects.has(objectKey(object))
      && sameObjectRow(previousObject, object)
      && sameObjectRow(object, nextObject)
      && documentOrder(previousObject, object) < 0
      && documentOrder(object, nextObject) < 0
    ));
    if (candidates.length !== unresolved.length) continue;
    unresolved.forEach((image, index) => bind(
      image,
      candidates[index],
      "unique remaining PDF object chain between proven neighboring asset bindings",
    ));
  }

  for (const image of images.filter((candidate) => !replacements.has(candidate.child.lid))) {
    replacements.set(image.child.lid, unmappedProjection(
      image,
      objects.length
        ? "PDF object candidates do not form a unique source-order or caption binding"
        : "PDF contains no image or Form object candidate",
    ));
  }

  return existingProjections.map((projection) => replacements.get(projection.lid) ?? projection);
}
