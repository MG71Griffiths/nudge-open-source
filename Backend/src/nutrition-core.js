// One backend boundary to the same offline engines bundled with the app.
// Keep dependency order explicit for their browser-compatible registrations.
import ScoreCore from '../../Web/core/nudge-score.js';
import Composition from '../../Web/core/food-composition.js';
import MealRecoveryData from '../../Web/core/meal-recovery-data.js';
import MealRecovery from '../../Web/core/meal-recovery.js';
import RecipeComposition from '../../Web/core/recipe-composition.js';
import MealScore from '../../Web/core/meal-score.js';

const DirectionalScoreCore=ScoreCore.Directional;
export { ScoreCore, DirectionalScoreCore, Composition, MealRecoveryData, MealRecovery, RecipeComposition, MealScore };
