function validate(recipe) {
  const errors = [];

  if (!recipe || typeof recipe !== 'object') {
    return { valid: false, errors: ['Recipe must be an object'] };
  }

  if (!Number.isInteger(recipe.version) || recipe.version < 1) {
    errors.push('version must be a positive integer');
  }

  if (typeof recipe.title !== 'string' || !recipe.title.trim()) {
    errors.push('title must be a non-empty string');
  }

  if (!Number.isInteger(recipe.default_servings) || recipe.default_servings < 1) {
    errors.push('default_servings must be a positive integer');
  }

  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    recipe.steps.forEach((step, si) => {
      if (typeof step.title !== 'string' || !step.title.trim()) {
        errors.push(`steps[${si}].title must be a non-empty string (1-3 words)`);
      }

      if (typeof step.description !== 'string' || !step.description.trim()) {
        errors.push(`steps[${si}].description must be a non-empty string`);
      }

      if (step.temperature_f !== null && step.temperature_f !== undefined && typeof step.temperature_f !== 'number') {
        errors.push(`steps[${si}].temperature_f must be a number or null`);
      }

      if (!Array.isArray(step.ingredients)) {
        errors.push(`steps[${si}].ingredients must be an array`);
      } else {
        step.ingredients.forEach((ing, ii) => {
          const prefix = `steps[${si}].ingredients[${ii}]`;

          if (typeof ing.name !== 'string' || !ing.name.trim()) {
            errors.push(`${prefix}.name must be a non-empty string`);
          }

          if (typeof ing.grams !== 'number' || ing.grams < 0) {
            errors.push(`${prefix}.grams must be a non-negative number`);
          }

          if (!ing.volume || typeof ing.volume.amount !== 'number' || ing.volume.amount < 0) {
            errors.push(`${prefix}.volume.amount must be a non-negative number`);
          }

          if (!ing.volume || typeof ing.volume.unit !== 'string' || !ing.volume.unit.trim()) {
            errors.push(`${prefix}.volume.unit must be a non-empty string`);
          }

          if (ing.macros) {
            for (const key of ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g']) {
              if (typeof ing.macros[key] !== 'number' || ing.macros[key] < 0) {
                errors.push(`${prefix}.macros.${key} must be a non-negative number`);
              }
            }
          } else {
            errors.push(`${prefix}.macros is required`);
          }
        });
      }
    });
  }

  if (recipe.serving_item !== undefined && recipe.serving_item !== null) {
    if (typeof recipe.serving_item !== 'object') {
      errors.push('serving_item must be an object');
    } else {
      if (typeof recipe.serving_item.count !== 'number' || recipe.serving_item.count <= 0) {
        errors.push('serving_item.count must be a positive number');
      }
      if (typeof recipe.serving_item.name !== 'string' || !recipe.serving_item.name.trim()) {
        errors.push('serving_item.name must be a non-empty string');
      }
    }
  }

  if (recipe.prep_time !== undefined && typeof recipe.prep_time !== 'string') {
    errors.push('prep_time must be a string');
  }

  if (recipe.cook_time !== undefined && typeof recipe.cook_time !== 'string') {
    errors.push('cook_time must be a string');
  }

  return { valid: errors.length === 0, errors };
}

function getSchemaReminder() {
  return `Recipe JSON must match this schema:
{
  "version": 1,
  "title": "string (required)",
  "description": "string",
  "default_servings": integer > 0 (required),
  "prep_time": "string",
  "cook_time": "string",
  "notes": "string",
  "serving_item": { "count": number > 0, "name": "string" }  (optional, for countable items like tacos, cookies),
  "steps": [  (required, non-empty)
    {
      "title": "string (required, 1-3 word step title)",
      "description": "string (required)",
      "temperature_f": number or null,
      "ingredients": [  (required, can be empty)
        {
          "name": "string (required)",
          "from_step": boolean (optional, true if output of a previous step — macros must be 0),
          "grams": number >= 0 (required),
          "volume": { "amount": number >= 0, "unit": "string" } (required),
          "macros": {  (required)
            "calories": number >= 0,
            "protein_g": number >= 0,
            "carbs_g": number >= 0,
            "fat_g": number >= 0,
            "fiber_g": number >= 0
          }
        }
      ]
    }
  ]
}`;
}

module.exports = { validate, getSchemaReminder };
