import { describe, it, expect } from 'vitest';
import { SHAPE_STYLES, EDGE_STYLES, DEFAULT_GEOMETRY } from '../styles.js';

describe('SHAPE_STYLES', () => {
  it('should have all documented shapes', () => {
    const expected = [
      'rectangle', 'roundedRectangle', 'ellipse', 'diamond', 'parallelogram',
      'hexagon', 'triangle', 'cylinder', 'cloud', 'document', 'process',
      'star', 'callout',
      // UML
      'actor', 'component', 'package', 'interface',
      // Flowchart
      'start', 'end', 'decision', 'processStep', 'inputOutput',
      // Architecture
      'server', 'database', 'firewall', 'user', 'container',
      // Colors
      'blue', 'green', 'red', 'yellow', 'purple', 'orange', 'gray',
    ];
    for (const name of expected) {
      expect(SHAPE_STYLES).toHaveProperty(name);
    }
  });

  it('all shape styles should be non-empty strings ending with semicolon', () => {
    for (const [name, style] of Object.entries(SHAPE_STYLES)) {
      expect(style, `${name} should be a string`).toBeTypeOf('string');
      expect(style.length, `${name} should not be empty`).toBeGreaterThan(0);
      expect(style, `${name} should end with ;`).toMatch(/;$/);
    }
  });

  it('all shape styles should contain html=1 (except component)', () => {
    const exceptions = ['component'];
    for (const [name, style] of Object.entries(SHAPE_STYLES)) {
      if (exceptions.includes(name)) continue;
      expect(style, `${name} should have html=1`).toContain('html=1');
    }
  });
});

describe('EDGE_STYLES', () => {
  it('should have all documented edge styles', () => {
    const expected = [
      'straight', 'orthogonal', 'curved', 'entityRelation',
      'arrow', 'openArrow', 'dashed', 'dotted', 'bidirectional', 'noArrow',
    ];
    for (const name of expected) {
      expect(EDGE_STYLES).toHaveProperty(name);
    }
  });

  it('all non-straight edge styles should end with semicolon', () => {
    for (const [name, style] of Object.entries(EDGE_STYLES)) {
      if (name === 'straight') continue; // straight is empty string
      expect(style, `${name} should end with ;`).toMatch(/;$/);
    }
  });

  it('straight style should be empty string', () => {
    expect(EDGE_STYLES.straight).toBe('');
  });
});

describe('DEFAULT_GEOMETRY', () => {
  it('should have x, y, width, height', () => {
    expect(DEFAULT_GEOMETRY).toEqual({
      x: 0,
      y: 0,
      width: 120,
      height: 60,
    });
  });
});
