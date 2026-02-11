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

export const EDGE_STYLES: Record<string, string> = {
  straight: '',
  orthogonal: 'edgeStyle=orthogonalEdgeStyle;',
  curved: 'curved=1;',
  entityRelation: 'edgeStyle=entityRelationEdgeStyle;',
  elbowHorizontal: 'edgeStyle=elbowEdgeStyle;elbow=horizontal;',
  elbowVertical: 'edgeStyle=elbowEdgeStyle;elbow=vertical;',
  // Arrow types
  arrow: 'endArrow=block;endFill=1;',
  openArrow: 'endArrow=open;endFill=0;',
  dashed: 'dashed=1;',
  dotted: 'dashed=1;dashPattern=1 2;',
  bidirectional: 'endArrow=block;endFill=1;startArrow=block;startFill=1;',
  noArrow: 'endArrow=none;endFill=0;',
};

export const DEFAULT_GEOMETRY = {
  x: 0,
  y: 0,
  width: 120,
  height: 60,
};
