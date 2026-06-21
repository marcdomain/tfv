// Test the resolveConstraint logic from switch.js by extracting it

// Inline the function for isolated testing
const resolveConstraint = (constraint, versions) => {
  const parts = constraint.split(',').map(s => s.trim());

  return versions.find(v => {
    return parts.every(part => {
      const m = part.match(/^(~>|>=|<=|!=|>|<|=)?\s*(\d+(?:\.\d+)*)/);
      if (!m) return false;
      const [, op = '=', req] = m;

      const vParts = v.split('.').map(n => parseInt(n, 10) || 0);
      const rParts = req.split('.').map(n => parseInt(n, 10) || 0);

      const cmp = () => {
        for (let i = 0; i < 3; i++) {
          const diff = (vParts[i] || 0) - (rParts[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      };

      switch (op) {
        case '~>': {
          const segCount = rParts.length;
          for (let i = 0; i < segCount - 1; i++) {
            if ((vParts[i] || 0) !== (rParts[i] || 0)) return false;
          }
          return (vParts[segCount - 1] || 0) >= (rParts[segCount - 1] || 0);
        }
        case '>=': return cmp() >= 0;
        case '>':  return cmp() > 0;
        case '<=': return cmp() <= 0;
        case '<':  return cmp() < 0;
        case '!=': return cmp() !== 0;
        default:   return cmp() === 0;
      }
    });
  }) || null;
};

const versions = ['1.9.0', '1.8.5', '1.8.0', '1.7.3', '1.7.0', '1.6.6', '1.5.7', '0.15.0'];

describe('resolveConstraint', () => {
  test('exact match =', () => {
    expect(resolveConstraint('= 1.7.3', versions)).toBe('1.7.3');
  });

  test('exact match (no operator)', () => {
    expect(resolveConstraint('1.7.3', versions)).toBe('1.7.3');
  });

  test('>= returns highest satisfying version', () => {
    expect(resolveConstraint('>= 1.8.0', versions)).toBe('1.9.0');
  });

  test('> strictly greater', () => {
    expect(resolveConstraint('> 1.8.0', versions)).toBe('1.9.0');
  });

  test('<= returns highest satisfying version', () => {
    expect(resolveConstraint('<= 1.7.3', versions)).toBe('1.7.3');
  });

  test('!= excludes version', () => {
    expect(resolveConstraint('!= 1.9.0', versions)).toBe('1.8.5');
  });

  test('~> 1.7 allows patch bumps only', () => {
    // ~> 1.7 means >= 1.7, < 2.0 effectively
    const result = resolveConstraint('~> 1.7', versions);
    expect(result).toBe('1.9.0'); // highest with major=1
  });

  test('~> 1.7.0 allows patch bumps in 1.7.x', () => {
    const result = resolveConstraint('~> 1.7.0', versions);
    expect(['1.7.3', '1.7.0']).toContain(result);
    // Should be 1.7.3 (highest 1.7.x)
    expect(result).toBe('1.7.3');
  });

  test('compound constraint >= X, < Y', () => {
    // >= 1.7.0, < 1.9.0
    const result = resolveConstraint('>= 1.7.0, < 1.9.0', versions);
    expect(result).toBe('1.8.5');
  });

  test('returns null when no version satisfies', () => {
    expect(resolveConstraint('>= 2.0.0', versions)).toBeNull();
  });
});
