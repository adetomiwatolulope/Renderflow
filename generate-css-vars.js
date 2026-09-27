const fs = require('fs');

const inputFile = 'design-tokens.tokens (1).json';
const outputFile = 'design-tokens.css';

try {
  const rawData = fs.readFileSync(inputFile, 'utf-8');
  const data = JSON.parse(rawData);

  // Utility to convert string to kebab-case
  function toKebabCase(str) {
    return str.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, '-').toLowerCase();
  }

  // Checks if an object is a design token
  function isToken(obj) {
    return obj && typeof obj === 'object' && 'value' in obj && 'type' in obj;
  }

  // Recursively find all tokens
  function flattenTokens(obj, currentPath = []) {
    let tokens = [];
    
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'extensions') continue; // Skip extensions
      
      if (isToken(val)) {
        tokens.push({
          path: [...currentPath, key],
          name: '--' + [...currentPath, key].map(toKebabCase).join('-'),
          type: val.type,
          value: val.value,
          description: val.description
        });
      } else if (typeof val === 'object' && val !== null) {
        tokens.push(...flattenTokens(val, [...currentPath, key]));
      }
    }
    return tokens;
  }

  const allTokens = flattenTokens(data);

  // Resolve token value to CSS valid string
  function resolveValue(value, type) {
    // Handle references e.g., {primitives.key colors.primary key color}
    if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
      const refPath = value.slice(1, -1).split('.');
      const refName = '--' + refPath.map(toKebabCase).join('-');
      return `var(${refName})`;
    }
    
    // Handle custom shadows (Figma Drop/Inner Shadow)
    if (type === 'custom-shadow' && typeof value === 'object') {
      const { offsetX, offsetY, radius, spread, color, shadowType } = value;
      const inset = shadowType === 'innerShadow' ? 'inset ' : '';
      const toPx = (v) => v === 0 ? '0' : `${v}px`;
      return `${inset}${toPx(offsetX)} ${toPx(offsetY)} ${toPx(radius)} ${toPx(spread)} ${color}`;
    }

    // Handle dimensions (add px if it's a number, standard CSS conversion)
    if (type === 'dimension' && typeof value === 'number') {
      return value === 0 ? '0' : `${value}px`;
    }
    
    return value;
  }

  // Group tokens to organize the CSS file
  const primitiveTokens = [];
  const roleTokens = [];
  const otherTokens = [];

  allTokens.forEach(token => {
    const topLevel = token.path[0];
    if (topLevel === 'primitives') {
      primitiveTokens.push(token);
    } else if (topLevel === 'color roles') {
      roleTokens.push(token);
    } else {
      otherTokens.push(token);
    }
  });

  let cssContent = `/* 
  Design System Tokens
  Auto-generated from ${inputFile}
*/\n\n:root {\n`;

  function appendSection(title, desc, tokensArray) {
    if (tokensArray.length === 0) return;
    cssContent += `  /* ==========================================\n`;
    cssContent += `     ${title}\n`;
    if (desc) cssContent += `     ${desc}\n`;
    cssContent += `     ========================================== */\n\n`;
    
    tokensArray.forEach(token => {
      if (token.description) {
        cssContent += `  /* ${token.description} */\n`;
      }
      // Write the CSS variable
      cssContent += `  ${token.name}: ${resolveValue(token.value, token.type)};\n`;
    });
    cssContent += `\n`;
  }

  // Follow the user's instructions: Note the colour system structure
  appendSection('PRIMITIVE COLORS', 'FOUNDATION ONLY - DO NOT USE THESE DIRECTLY ON THE UI.', primitiveTokens);
  appendSection('COLOR ROLES', 'SEMANTIC UI COLORS - Apply these variables directly to your UI components.', roleTokens);
  appendSection('OTHER TOKENS', 'Typography, Spacing, Effects, etc.', otherTokens);

  cssContent += `}\n`;

  fs.writeFileSync(outputFile, cssContent, 'utf-8');
  console.log(`Successfully generated ${outputFile} with ${allTokens.length} tokens.`);

} catch (error) {
  console.error("Error processing tokens:", error);
}
