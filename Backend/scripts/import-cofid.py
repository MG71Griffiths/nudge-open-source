"""Reproducible import of official CoFID 2021. No external Python dependencies.
Usage: python3 Backend/scripts/import-cofid.py /path/CoFID-2021.xlsx
The workbook is public Crown copyright, Open Government Licence v3.0.
"""
import hashlib, json, re, sys, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
SOURCE='https://assets.publishing.service.gov.uk/media/60538b91e90e07527df82ae4/McCance_Widdowsons_Composition_of_Foods_Integrated_Dataset_2021..xlsx'
EXPECTED='436e9445ef2adb2a75f3d7edd51302de3adad25385f9795fc94ba58bd030e97d'
b=Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(b).hexdigest()==EXPECTED, 'Source changed: review before importing'
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
 strings=[''.join(el.itertext()) for el in ET.fromstring(z.read('xl/sharedStrings.xml'))]
 def rows(sheet):
  for row in ET.fromstring(z.read('xl/worksheets/sheet%d.xml'%sheet)).find('m:sheetData',ns):
   if int(row.attrib['r'])<4: continue
   d={}
   for c in row:
    v=c.find('m:v',ns)
    d[re.sub('[0-9]','',c.attrib['r'])]=strings[int(v.text)] if c.attrib.get('t')=='s' and v is not None else v.text if v is not None else ''
   if d.get('A') and d.get('B'): yield d
 prox=list(rows(4)); minerals={(r['A'],r['B']):r for r in rows(5)}
 assert len(prox)==2887 and len(minerals)==2887
 foods=[]
 for r in prox:
  values={k:r.get(col,'') for k,col in {'energyKcal':'M','energyKj':'N','protein':'J','carbohydrate':'L','sugars':'Q','fat':'K','saturatedFat':'AB','fibre':'Z'}.items()}
  values['sodiumMg']=minerals.get((r['A'],r['B']),{}).get('H','')
  foods.append({'id':r['A']+':'+hashlib.sha256(r['B'].encode()).hexdigest()[:12], 'code':r['A'],'name':r['B'],'description':r.get('C',''),'reference':r.get('F',''),'values':values})
manifest={'version':'CoFID-2021-proximates-v1','publishedAt':'2021-03-19','retrievedAt':'2026-10-03','sourceURL':SOURCE,'sourceSHA256':EXPECTED,'guideURL':'https://assets.publishing.service.gov.uk/media/60538e66d3bf7f03249bac58/McCance_and_Widdowsons_Composition_of_Foods_integrated_dataset_2021.pdf','licenceURL':'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/','attribution':'Contains public sector information licensed under the Open Government Licence v3.0. Crown copyright. McCance and Widdowson’s Composition of Foods Integrated Dataset 2021, Public Health England.','basis':'per 100 g edible food; cooked/raw state is part of each record name','fibreDefinition':'AOAC only; NSP is not substituted','foods':foods}
out=Path(__file__).resolve().parent.parent/'data/cofid-2021.json'
out.write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':'))+'\n')
print('Imported',len(foods),'unique code/name records;',out.stat().st_size,'bytes')
