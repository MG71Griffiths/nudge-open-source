import {it} from 'node:test';
import assert from 'node:assert/strict';
import {archiveOFFSource,archiveOFFImport} from '../src/off-source-archive.js';
it('retains every full source field separately, with stable content-addressed snapshot',async()=>{
 const saved=[],bucket={put:async(...args)=>saved.push(args)};
 const payload={status:'success',product:{code:'5063334012694',arbitrary_new_field:{unicode:'é',array:[null,0,false]},attribute_groups_data:[{match:81}]}};
 const metadata={barcode:payload.product.code,fetchedAt:Date.now(),sourceURL:'https://world.openfoodfacts.org/api/v3.6/product/5063334012694.json?fields=all'};
 const a=await archiveOFFSource(bucket,payload,metadata),b=await archiveOFFSource(bucket,payload,metadata);
 assert.equal(a.key,b.key);assert.match(a.key,/^off-source\/v1\/5063334012694\/[a-f0-9]{64}\.json$/);
 assert.deepEqual(JSON.parse(new TextDecoder().decode(saved[0][1])),payload);
 assert.equal(saved[0][2].customMetadata.sourceURL,metadata.sourceURL);
 await assert.rejects(archiveOFFSource(bucket,payload,{...metadata,barcode:'0000000000000'}));
});
it('archives complete input batch and does not touch image manifests or jobs',async()=>{
 const calls=[],bucket={put:async(...args)=>calls.push(args)};
 const body={products:[{code:'1234567890123',extra:{not_projected:true}}],fetchedAt:Date.now(),sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz'};
 const result=await archiveOFFImport(bucket,body);assert.match(result.key,/^off-source\/imports\/v1\//);
 assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0][1])),body);assert.equal(calls.length,1);
});
