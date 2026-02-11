import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { SHAPE_STYLES, EDGE_STYLES, DEFAULT_GEOMETRY } from './styles.js';

// XML parser/builder config for draw.io format
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  preserveOrder: true,
  commentPropName: '#comment',
  trimValues: false,
};

const builderOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  format: true,
  indentBy: '  ',
  suppressBooleanAttributes: false,
  commentPropName: '#comment',
};

const parser = new XMLParser(parserOptions);
const builder = new XMLBuilder(builderOptions);

// Track files we're currently writing to avoid echo
const writingFiles = new Set<string>();

// File change callbacks
type FileChangeCallback = (filePath: string) => void;
const fileWatchers = new Map<string, fs.FSWatcher>();
const changeCallbacks: FileChangeCallback[] = [];

export function onDiagramFileChanged(callback: FileChangeCallback): void {
  changeCallbacks.push(callback);
}

export function watchDiagramFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (fileWatchers.has(resolved)) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(resolved, (eventType) => {
    if (eventType !== 'change') return;
    if (writingFiles.has(resolved)) return;  // Skip our own writes

    // Debounce to avoid duplicate events
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      for (const cb of changeCallbacks) {
        cb(resolved);
      }
    }, 200);
  });

  fileWatchers.set(resolved, watcher);
}

export function unwatchDiagramFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
}

export function unwatchAll(): void {
  for (const [, watcher] of fileWatchers) {
    watcher.close();
  }
  fileWatchers.clear();
}

export interface ChangeRecord {
  id: string;
  timestamp: string;
  operation: string;
  filePath: string;
  description: string;
  beforeXml: string;
  afterXml?: string;
  elementIds: string[];
}

const changeHistory: ChangeRecord[] = [];
const MAX_HISTORY = 50;
let undoneRecords: ChangeRecord[] = [];

export function recordChange(record: Omit<ChangeRecord, 'id' | 'timestamp'>): string {
  const id = generateId();
  const fullRecord: ChangeRecord = {
    ...record,
    id,
    timestamp: new Date().toISOString(),
  };
  changeHistory.push(fullRecord);
  undoneRecords = [];
  if (changeHistory.length > MAX_HISTORY) {
    changeHistory.splice(0, changeHistory.length - MAX_HISTORY);
  }
  return id;
}

export function getHistory(limit?: number): ChangeRecord[] {
  if (limit !== undefined) {
    return changeHistory.slice(-limit);
  }
  return [...changeHistory];
}

export async function undoLastOperation(): Promise<{ success: boolean; record?: ChangeRecord }> {
  const record = changeHistory.pop();
  if (!record) return { success: false };
  await writeXml(record.filePath, record.beforeXml);
  undoneRecords.push(record);
  return { success: true, record };
}

export async function redoLastOperation(): Promise<{ success: boolean; record?: ChangeRecord }> {
  const record = undoneRecords.pop();
  if (!record || !record.afterXml) return { success: false };
  await writeXml(record.filePath, record.afterXml);
  changeHistory.push(record);
  return { success: true, record };
}

export interface DiagramNode {
  id: string;
  value: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  parent: string;
  geometry?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    relative?: boolean;
  };
}

export interface DiagramPage {
  id: string;
  name: string;
  nodes: DiagramNode[];
}

export interface DiagramInfo {
  filePath: string;
  pages: DiagramPage[];
  totalNodes: number;
  totalEdges: number;
}

/** Generate a unique ID for new cells */
function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 20; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** Create empty draw.io XML */
export function createEmptyDiagram(pageName: string = 'Page-1'): string {
  const diagramId = generateId();
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="drawio-mcp" modified="${new Date().toISOString()}" agent="drawio-mcp" version="1.0.0" type="device">
  <diagram id="${diagramId}" name="${pageName}">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

/** Read and parse a draw.io file */
export async function readDiagram(filePath: string): Promise<DiagramInfo> {
  const resolvedPath = path.resolve(filePath);
  const content = await fsp.readFile(resolvedPath, 'utf-8');
  const result = parseDiagramXml(content, resolvedPath);
  watchDiagramFile(resolvedPath);
  return result;
}

/** Parse draw.io XML string into structured data */
function parseDiagramXml(xml: string, filePath: string): DiagramInfo {
  const parsed = parser.parse(xml);
  const pages: DiagramPage[] = [];
  let totalNodes = 0;
  let totalEdges = 0;

  // Navigate: mxfile > diagram(s)
  const mxfileItem = findItem(parsed, 'mxfile');
  if (!mxfileItem) throw new Error('Invalid draw.io file: no mxfile element found');
  const mxfileChildren = mxfileItem['mxfile'] as any[];

  const diagramItems = findAllItems(mxfileChildren, 'diagram');

  for (const diagramItem of diagramItems) {
    const attrs = getAttrs(diagramItem);
    const pageId = attrs['id'] || generateId();
    const pageName = attrs['name'] || 'Untitled';
    const nodes: DiagramNode[] = [];
    const diagramChildren = diagramItem['diagram'] as any[];

    const graphModelItem = findItem(diagramChildren, 'mxGraphModel');
    if (!graphModelItem) continue;
    const graphModelChildren = graphModelItem['mxGraphModel'] as any[];

    const rootItem = findItem(graphModelChildren, 'root');
    if (!rootItem) continue;
    const rootChildren = rootItem['root'] as any[];

    const cellItems = findAllItems(rootChildren, 'mxCell');
    for (const cellItem of cellItems) {
      const cellAttrs = getAttrs(cellItem);
      const id = cellAttrs['id'] || '';

      // Skip root cells (id=0, id=1)
      if (id === '0' || id === '1') continue;

      const isVertex = cellAttrs['vertex'] === '1';
      const isEdge = cellAttrs['edge'] === '1';

      const node: DiagramNode = {
        id,
        value: cellAttrs['value'] || '',
        style: cellAttrs['style'] || '',
        vertex: isVertex,
        edge: isEdge,
        parent: cellAttrs['parent'] || '1',
        source: cellAttrs['source'],
        target: cellAttrs['target'],
      };

      // Parse geometry from cell's children
      const cellChildren = cellItem['mxCell'] as any[];
      const geomItem = findItem(cellChildren, 'mxGeometry');
      if (geomItem) {
        const geomAttrs = getAttrs(geomItem);
        node.geometry = {
          x: geomAttrs['x'] ? Number(geomAttrs['x']) : undefined,
          y: geomAttrs['y'] ? Number(geomAttrs['y']) : undefined,
          width: geomAttrs['width'] ? Number(geomAttrs['width']) : undefined,
          height: geomAttrs['height'] ? Number(geomAttrs['height']) : undefined,
          relative: geomAttrs['relative'] === '1',
        };
      }

      nodes.push(node);
      if (isVertex) totalNodes++;
      if (isEdge) totalEdges++;
    }

    pages.push({ id: pageId, name: pageName, nodes });
  }

  return { filePath, pages, totalNodes, totalEdges };
}

/** Find an item by tag name in preserveOrder array, returns the full item object */
function findItem(arr: any[], tagName: string): any | undefined {
  for (const item of arr) {
    if (item[tagName] !== undefined) {
      return item;
    }
  }
  return undefined;
}

/** Find all items with a given tag name in preserveOrder array */
function findAllItems(arr: any[], tagName: string): any[] {
  const results: any[] = [];
  for (const item of arr) {
    if (item[tagName] !== undefined) {
      results.push(item);
    }
  }
  return results;
}

/** Get attributes from a preserveOrder item (attributes are in ':@' property) */
function getAttrs(item: any): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (item[':@']) {
    for (const [key, value] of Object.entries(item[':@'])) {
      const cleanKey = key.replace(/^@_/, '');
      attrs[cleanKey] = String(value);
    }
  }
  return attrs;
}

/** Read raw XML from file */
async function readRawXml(filePath: string): Promise<string> {
  return fsp.readFile(path.resolve(filePath), 'utf-8');
}

/** Write XML to file */
async function writeXml(filePath: string, xml: string): Promise<void> {
  const resolved = path.resolve(filePath);
  writingFiles.add(resolved);
  await fsp.writeFile(resolved, xml, 'utf-8');
  // Remove from writing set after a short delay to avoid catching our own event
  setTimeout(() => writingFiles.delete(resolved), 500);
}

/** Create a new draw.io diagram file */
export async function createDiagramFile(
  filePath: string,
  pageName: string = 'Page-1'
): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const xml = createEmptyDiagram(pageName);
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeXml(resolvedPath, xml);
  watchDiagramFile(resolvedPath);
  return resolvedPath;
}

/** Add a node (vertex) to a diagram */
export async function addNode(
  filePath: string,
  options: {
    label: string;
    shape?: string;
    style?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    pageIndex?: number;
    id?: string;
  }
): Promise<{ id: string; filePath: string; changeId: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  const nodeId = options.id || generateId();
  let style = options.style || '';

  // Apply predefined shape style if specified
  if (options.shape && SHAPE_STYLES[options.shape]) {
    style = SHAPE_STYLES[options.shape] + style;
  } else if (!style) {
    style = SHAPE_STYLES.roundedRectangle;
  }

  const x = options.x ?? DEFAULT_GEOMETRY.x;
  const y = options.y ?? DEFAULT_GEOMETRY.y;
  const width = options.width ?? DEFAULT_GEOMETRY.width;
  const height = options.height ?? DEFAULT_GEOMETRY.height;

  const cellXml = `        <mxCell id="${nodeId}" value="${escapeXml(options.label)}" style="${escapeXml(style)}" vertex="1" parent="1">
          <mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" />
        </mxCell>`;

  xml = insertCellIntoPage(xml, cellXml, options.pageIndex ?? 0);
  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'add_node',
    filePath: resolvedPath,
    description: `Added node "${options.label}" (${nodeId})`,
    beforeXml,
    afterXml,
    elementIds: [nodeId],
  });

  return { id: nodeId, filePath: resolvedPath, changeId };
}

/** Add an edge (connection) between two nodes */
export async function addEdge(
  filePath: string,
  options: {
    sourceId: string;
    targetId: string;
    label?: string;
    style?: string;
    edgeStyle?: string;
    pageIndex?: number;
    id?: string;
  }
): Promise<{ id: string; filePath: string; changeId: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  const edgeId = options.id || generateId();
  let style = options.style || '';

  if (options.edgeStyle && EDGE_STYLES[options.edgeStyle]) {
    style = EDGE_STYLES[options.edgeStyle] + style;
  }

  const label = options.label || '';

  const cellXml = `        <mxCell id="${edgeId}" value="${escapeXml(label)}" style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(options.sourceId)}" target="${escapeXml(options.targetId)}">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>`;

  xml = insertCellIntoPage(xml, cellXml, options.pageIndex ?? 0);
  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'add_edge',
    filePath: resolvedPath,
    description: `Added edge "${label}" from ${options.sourceId} to ${options.targetId} (${edgeId})`,
    beforeXml,
    afterXml,
    elementIds: [edgeId],
  });

  return { id: edgeId, filePath: resolvedPath, changeId };
}

/** Update an existing element's properties */
export async function updateElement(
  filePath: string,
  elementId: string,
  updates: {
    label?: string;
    style?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }
): Promise<{ success: boolean; changeId?: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  // Find the mxCell with the given ID using regex
  const cellRegex = new RegExp(
    `(<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^>]*?)(/?>)`,
    's'
  );
  const match = xml.match(cellRegex);
  if (!match) return { success: false };

  let cellTag = match[1];
  const closing = match[2];

  // Update attributes
  if (updates.label !== undefined) {
    cellTag = replaceOrAddAttr(cellTag, 'value', updates.label);
  }
  if (updates.style !== undefined) {
    cellTag = replaceOrAddAttr(cellTag, 'style', updates.style);
  }

  xml = xml.replace(match[0], cellTag + closing);

  // Update geometry if position/size changed
  if (updates.x !== undefined || updates.y !== undefined || updates.width !== undefined || updates.height !== undefined) {
    // Match just the mxGeometry tag that follows the mxCell with this ID
    const geomRegex = new RegExp(
      `(<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^>]*>[\\s]*<mxGeometry\\s)([^/]*?)(\\/?>)`,
      's'
    );
    const geomMatch = xml.match(geomRegex);
    if (geomMatch) {
      let geomAttrs = geomMatch[2];
      if (updates.x !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'x', String(updates.x));
      if (updates.y !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'y', String(updates.y));
      if (updates.width !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'width', String(updates.width));
      if (updates.height !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'height', String(updates.height));
      xml = xml.replace(geomMatch[0], geomMatch[1] + geomAttrs + geomMatch[3]);
    }
  }

  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'update_element',
    filePath: resolvedPath,
    description: `Updated element ${elementId}`,
    beforeXml,
    afterXml,
    elementIds: [elementId],
  });

  return { success: true, changeId };
}

/** Remove an element by ID */
export async function removeElement(
  filePath: string,
  elementId: string
): Promise<{ success: boolean; changeId?: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  // Match self-closing or full mxCell with nested content
  const selfClosingRegex = new RegExp(
    `\\s*<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^/]*/>[\\t ]*\\n?`,
    's'
  );
  const fullRegex = new RegExp(
    `\\s*<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^>]*>[\\s\\S]*?</mxCell>[\\t ]*\\n?`,
    's'
  );

  let found = false;
  if (fullRegex.test(xml)) {
    xml = xml.replace(fullRegex, '\n');
    found = true;
  } else if (selfClosingRegex.test(xml)) {
    xml = xml.replace(selfClosingRegex, '\n');
    found = true;
  }

  if (found) {
    await writeXml(resolvedPath, xml);
    const afterXml = await readRawXml(resolvedPath);
    const changeId = recordChange({
      operation: 'remove_element',
      filePath: resolvedPath,
      description: `Removed element ${elementId}`,
      beforeXml,
      afterXml,
      elementIds: [elementId],
    });
    return { success: true, changeId };
  }
  return { success: false };
}

/** Add a new page to a diagram */
export async function addPage(
  filePath: string,
  pageName: string
): Promise<{ pageId: string; filePath: string; changeId: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  const pageId = generateId();
  const newPage = `  <diagram id="${pageId}" name="${escapeXml(pageName)}">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>`;

  // Insert before </mxfile>
  xml = xml.replace('</mxfile>', newPage + '\n</mxfile>');
  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'add_page',
    filePath: resolvedPath,
    description: `Added page "${pageName}" (${pageId})`,
    beforeXml,
    afterXml,
    elementIds: [pageId],
  });

  return { pageId, filePath: resolvedPath, changeId };
}

/** List all .drawio files in a directory recursively */
export async function listDiagramFiles(dir: string): Promise<string[]> {
  const resolvedDir = path.resolve(dir);
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await fsp.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.drawio') || entry.name.endsWith('.dio'))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  await walk(resolvedDir);
  return files;
}

// --- Utility functions ---

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOrAddAttr(tag: string, attr: string, value: string): string {
  // Use word boundary to avoid matching inside other attribute names (e.g., 'x' inside 'vertex')
  const attrRegex = new RegExp(`\\b${attr}="[^"]*"`);
  if (attrRegex.test(tag)) {
    return tag.replace(attrRegex, `${attr}="${escapeXml(value)}"`);
  }
  return tag + ` ${attr}="${escapeXml(value)}"`;
}

/** Insert a cell XML snippet into the specified page's <root> */
function insertCellIntoPage(xml: string, cellXml: string, pageIndex: number): string {
  // Find all </root> tags and insert before the one at pageIndex
  const rootCloseRegex = /<\/root>/g;
  let match: RegExpExecArray | null;
  let currentIndex = 0;

  while ((match = rootCloseRegex.exec(xml)) !== null) {
    if (currentIndex === pageIndex) {
      const insertPos = match.index;
      return xml.slice(0, insertPos) + cellXml + '\n' + xml.slice(insertPos);
    }
    currentIndex++;
  }

  // If pageIndex not found, insert in last page
  const lastRootClose = xml.lastIndexOf('</root>');
  if (lastRootClose !== -1) {
    return xml.slice(0, lastRootClose) + cellXml + '\n' + xml.slice(lastRootClose);
  }

  throw new Error('Cannot find <root> element in diagram');
}
