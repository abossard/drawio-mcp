/** Predefined draw.io shape and edge styles */

export const SHAPE_STYLES: Record<string, string> = {
  rectangle: 'rounded=0;whiteSpace=wrap;html=1;',
  roundedRectangle: 'rounded=1;whiteSpace=wrap;html=1;',
  ellipse: 'ellipse;whiteSpace=wrap;html=1;',
  diamond: 'rhombus;whiteSpace=wrap;html=1;',
  parallelogram: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;',
  hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;',
  triangle: 'triangle;whiteSpace=wrap;html=1;',
  cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;',
  cloud: 'ellipse;shape=cloud;whiteSpace=wrap;html=1;',
  document: 'shape=document;whiteSpace=wrap;html=1;boundedLbl=1;',
  process: 'shape=process;whiteSpace=wrap;html=1;',
  star: 'shape=mxgraph.basic.star;whiteSpace=wrap;html=1;',
  callout: 'shape=callout;whiteSpace=wrap;html=1;perimeter=calloutPerimeter;',
  // UML
  actor: 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;',
  component: 'shape=component;align=left;spacingLeft=36;',
  package: 'shape=folder;fontStyle=1;tabWidth=110;tabHeight=30;tabPosition=left;html=1;whiteSpace=wrap;',
  interface: 'shape=providedRequiredInterface;html=1;verticalLabelPosition=bottom;',
  // Flowchart
  start: 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#d5e8d4;strokeColor=#82b366;',
  end: 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#f8cecc;strokeColor=#b85450;',
  decision: 'rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;',
  processStep: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  inputOutput: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;fillColor=#e1d5e7;strokeColor=#9673a6;',
  // Architecture
  server: 'shape=mxgraph.cisco.servers.standard_server;sketch=0;html=1;',
  database: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  firewall: 'shape=mxgraph.cisco.firewalls.firewall;sketch=0;html=1;',
  user: 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;',
  container: 'rounded=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=5 5;fillColor=none;strokeColor=#666666;fontSize=14;fontStyle=1;verticalAlign=top;spacingTop=5;',
  // Colors
  blue: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  green: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;',
  red: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;',
  yellow: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;',
  purple: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;',
  orange: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;',
  gray: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;',
};

// Base edge properties for readable labels (white background behind text)
const EDGE_LABEL_BASE = 'fontSize=11;fontFamily=Helvetica;labelBackgroundColor=#ffffff;';

export const EDGE_STYLES: Record<string, string> = {
  // Routing styles
  straight: EDGE_LABEL_BASE,
  orthogonal: `edgeStyle=orthogonalEdgeStyle;rounded=1;${EDGE_LABEL_BASE}`,
  orthogonalSharp: `edgeStyle=orthogonalEdgeStyle;rounded=0;${EDGE_LABEL_BASE}`,
  curved: `curved=1;${EDGE_LABEL_BASE}`,
  entityRelation: `edgeStyle=entityRelationEdgeStyle;${EDGE_LABEL_BASE}`,
  elbowHorizontal: `edgeStyle=elbowEdgeStyle;elbow=horizontal;${EDGE_LABEL_BASE}`,
  elbowVertical: `edgeStyle=elbowEdgeStyle;elbow=vertical;${EDGE_LABEL_BASE}`,
  isometric: `edgeStyle=isometricEdgeStyle;${EDGE_LABEL_BASE}`,
  // Arrow types
  arrow: `endArrow=block;endFill=1;${EDGE_LABEL_BASE}`,
  openArrow: `endArrow=open;endFill=0;${EDGE_LABEL_BASE}`,
  dashed: `dashed=1;${EDGE_LABEL_BASE}`,
  dotted: `dashed=1;dashPattern=1 2;${EDGE_LABEL_BASE}`,
  bidirectional: `endArrow=block;endFill=1;startArrow=block;startFill=1;${EDGE_LABEL_BASE}`,
  noArrow: `endArrow=none;endFill=0;${EDGE_LABEL_BASE}`,
  // Combined routing + arrow styles (most useful for architecture diagrams)
  orthogonalDashed: `edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;${EDGE_LABEL_BASE}`,
  curvedDashed: `curved=1;dashed=1;${EDGE_LABEL_BASE}`,
  orthogonalBidirectional: `edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;endFill=1;startArrow=block;startFill=1;${EDGE_LABEL_BASE}`,
  curvedBidirectional: `curved=1;endArrow=block;endFill=1;startArrow=block;startFill=1;${EDGE_LABEL_BASE}`,
  orthogonalNoArrow: `edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=none;endFill=0;${EDGE_LABEL_BASE}`,
};

/**
 * Connection point presets for controlling where edges attach to nodes.
 * Values are fractions (0-1) of the node's width (x) and height (y).
 * 
 *   (0,0)----(0.5,0)----(1,0)
 *     |                    |
 *   (0,0.5)            (1,0.5)
 *     |                    |
 *   (0,1)----(0.5,1)----(1,1)
 */
export const CONNECTION_POINTS: Record<string, { x: number; y: number }> = {
  top:         { x: 0.5, y: 0 },
  bottom:      { x: 0.5, y: 1 },
  left:        { x: 0, y: 0.5 },
  right:       { x: 1, y: 0.5 },
  topLeft:     { x: 0, y: 0 },
  topRight:    { x: 1, y: 0 },
  bottomLeft:  { x: 0, y: 1 },
  bottomRight: { x: 1, y: 1 },
  // Offset positions for parallel edges — slightly off-center to avoid overlap
  topLeft25:     { x: 0.25, y: 0 },
  topRight75:    { x: 0.75, y: 0 },
  bottomLeft25:  { x: 0.25, y: 1 },
  bottomRight75: { x: 0.75, y: 1 },
  leftTop25:     { x: 0, y: 0.25 },
  leftBottom75:  { x: 0, y: 0.75 },
  rightTop25:    { x: 1, y: 0.25 },
  rightBottom75: { x: 1, y: 0.75 },
};

export const DEFAULT_GEOMETRY = {
  x: 0,
  y: 0,
  width: 120,
  height: 60,
};
