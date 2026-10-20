"""Portable checks for the shipped project. These do not compile Swift or run iOS."""
from pathlib import Path
import json
import plistlib
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'Web'


def parse_project(text):
    # Xcode's OpenStep property-list grammar as used by this generated project.
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|[{}()=;,]|[^\s{}()=;,]+',
                        re.sub(r'//[^\n]*', '', text))
    pos = 0

    def take():
        nonlocal pos
        assert pos < len(tokens), 'Unexpected end of project'
        token = tokens[pos]
        pos += 1
        return token

    def expect(value):
        assert take() == value, 'Invalid project property list'

    def value():
        token = take()
        if token == '{':
            result = {}
            while tokens[pos] != '}':
                key = take()
                key = json.loads(key) if key.startswith('"') else key
                expect('=')
                assert key not in result, 'Duplicate project key'
                result[key] = value()
                expect(';')
            expect('}')
            return result
        if token == '(':
            result = []
            while tokens[pos] != ')':
                result.append(value())
                if tokens[pos] == ',':
                    take()
            expect(')')
            return result
        return json.loads(token) if token.startswith('"') else token

    result = value()
    assert pos == len(tokens), 'Trailing project tokens'
    return result


project = parse_project((ROOT / 'Nudge.xcodeproj/project.pbxproj').read_text())
objects = project['objects']
assert objects[project['rootObject']]['isa'] == 'PBXProject'
reference_keys = {'fileRef', 'mainGroup', 'productRefGroup', 'productReference',
                  'buildConfigurationList', 'target', 'targetProxy', 'containerPortal',
                  'remoteGlobalIDString', 'TestTargetID'}
reference_lists = {'children', 'files', 'buildPhases', 'dependencies', 'targets', 'buildConfigurations'}
for key, obj in objects.items():
    assert re.fullmatch(r'[0-9A-F]{24}', key)
    for field in reference_keys:
        if field in obj:
            assert obj[field] in objects, f'Missing project reference: {field}'
    for field in reference_lists:
        for reference in obj.get(field, []):
            assert reference in objects, f'Missing project reference: {field}'


def check_group(identifier, base):
    group = objects[identifier]
    base = base / group.get('path', '')
    for child in group.get('children', []):
        entry = objects[child]
        if entry['isa'] == 'PBXGroup':
            check_group(child, base)
        elif entry.get('sourceTree') != 'BUILT_PRODUCTS_DIR':
            assert (base / entry['path']).exists(), f'Missing Xcode file: {entry}'


check_group(objects[project['rootObject']]['mainGroup'], ROOT)
targets = [obj for obj in objects.values() if obj['isa'] == 'PBXNativeTarget']
assert {target['name'] for target in targets} == {'Nudge', 'NudgeTests', 'NudgeUITests'}
ui_tests = next(t for t in targets if t['name'] == 'NudgeUITests')
for config_id in objects[ui_tests['buildConfigurationList']]['buildConfigurations']:
    assert objects[config_id]['buildSettings']['SUPPORTED_PLATFORMS'] == 'iphonesimulator', 'UI automation must stay simulator-only'
app = next(t for t in targets if t['name'] == 'Nudge')
resources = next(objects[p] for p in app['buildPhases'] if objects[p]['isa'] == 'PBXResourcesBuildPhase')
resource_names = {objects[objects[ref]['fileRef']]['path'] for ref in resources['files']}
assert {'Web', 'PrivacyInfo.xcprivacy'} <= resource_names
scheme = ET.parse(ROOT / 'Nudge.xcodeproj/xcshareddata/xcschemes/Nudge.xcscheme')
for ref in scheme.iter('BuildableReference'):
    assert ref.attrib['BlueprintIdentifier'] in objects
    assert objects[ref.attrib['BlueprintIdentifier']]['name'] == ref.attrib['BlueprintName']
for file in [ROOT / 'Nudge/Info.plist', ROOT / 'Nudge/PrivacyInfo.xcprivacy']:
    with file.open('rb') as handle:
        plistlib.load(handle)

html = (WEB / 'index.html').read_text()
for asset in re.findall(r'(?:src|href)="(/[^"#]+)', html):
    assert (WEB / asset.split('?', 1)[0].lstrip('/')).is_file(), f'Missing HTML resource: {asset}'
assert 'viewport-fit=cover' in html
assert html.count('href="/native.css"') == 1
assert 'fonts.googleapis.com' not in (WEB / 'style.css').read_text()
assert not re.search(r'(?:src|href)="https?://', html), 'Remote HTML dependency'
for file in WEB.glob('*.css'):
    assert not re.search(r'@import|url\([\s\'"]*https?://', file.read_text()), f'Remote CSS dependency: {file}'
assert not list(ROOT.rglob('*.mobileprovision')), 'Provisioning profiles must not be shipped'
assert not list(ROOT.rglob('*.p12')), 'Signing credentials must not be shipped'
print(f'Passed: {len(objects)} project objects, app/test schemes, bundled resources, plists, offline entry page and no signing secrets.')
