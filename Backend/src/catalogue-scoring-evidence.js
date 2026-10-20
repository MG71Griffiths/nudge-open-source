import {ScoreCore} from './nutrition-core.js';
import {scoreDirectionalProduct} from './product-score.js';
import {evaluateCatalogueEnrichment,ENRICHMENT_VERSION} from './catalogue-enrichment-evidence.js';

// The caller joins these evidence rows to the retained source fingerprint and
// checks expiry. Never accept their old final score or a model-authored number.
const choice=value=>({category:value.category,evidence:value.evidence,sweeteners:value.sweeteners||'unknown',sweetenerEvidence:value.sweetenerEvidence||[]});
export function replayDirectionalCatalogueEvidence(raw,product,{classificationJSON,enrichmentJSON}={},now=Date.now()){
 let result=scoreDirectionalProduct(product),classification=null,rejected=false,reused=false;
 if(classificationJSON){try{
  classification=choice(JSON.parse(classificationJSON));
  const validated=ScoreCore.Directional.validateClassification(product,classification);
  if(validated.conflicts.length)throw new Error('incompatible retained classification');
  result=scoreDirectionalProduct(product,validated);reused=true;
 }catch{classification=null;rejected=true;}}
 if(enrichmentJSON){try{
  const canonical=JSON.parse(enrichmentJSON);
  if(canonical.version!==ENRICHMENT_VERSION||canonical.provenance?.sourceRevision!==(raw.last_modified_t??null))throw new Error('obsolete evidence');
  const options={now,classification:choice(canonical.classification)};
  const label=canonical.evidence?.find(e=>e.kind==='public_label');
  if(label)options.nutritionEvidence={version:label.version,barcode:String(raw.code),sourceRevision:raw.last_modified_t??null,
   sourceURL:label.sourceURL,images:label.images,extraction:label.extraction};
  const composition=canonical.evidence?.find(e=>e.kind==='sourced_composition');
  if(composition)options.compositionRecordId=composition.recordId;
  let evaluated;
  try{evaluated=evaluateCatalogueEnrichment(raw,options,ScoreCore.Directional);}
  catch(error){if(!composition||!/Composition source was not (?:needed|offered)/.test(error.message))throw error;delete options.compositionRecordId;evaluated=evaluateCatalogueEnrichment(raw,options,ScoreCore.Directional);}
  if(evaluated.classification.conflicts.length)throw new Error('incompatible retained classification');
  result=evaluated.score;reused=true;
 }catch{rejected=true;}}
 return reused||rejected?{...result,catalogueEvidenceReplay:{version:'retained-facts-replay-v1',reused,rejected}}:result;
}
