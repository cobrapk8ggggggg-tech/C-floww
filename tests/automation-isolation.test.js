'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mongoDatabase,firestoreDatabase}=require('../backend/config/automationIsolation');
test('shared production credentials never select production databases in this branch',()=>{
  assert.equal(mongoDatabase({}),'zeus_automation_staging');
  assert.equal(firestoreDatabase({}),'zeus-automation-staging');
  for(const name of ['novels','production','(default)','admin','zeus_automation_'])
    assert.throws(()=>mongoDatabase({AUTOMATION_DB_NAME:name}));
  for(const name of ['(default)','production','novels','zeus-automation-'])
    assert.throws(()=>firestoreDatabase({AUTOMATION_FIRESTORE_DATABASE:name}));
});
test('a free default Firestore database requires explicit independent project identity',()=>{
 const {firebaseProject}=require('../backend/config/automationIsolation');
 const env={AUTOMATION_FIRESTORE_DATABASE:'(default)',AUTOMATION_FIREBASE_PROJECT_ID:'zeus-automation-test',PRODUCTION_FIREBASE_PROJECT_ID:'existing-production'};
 assert.equal(firestoreDatabase(env),'(default)');assert.equal(firebaseProject('zeus-automation-test',env),'zeus-automation-test');
 assert.throws(()=>firebaseProject('existing-production',env));
 assert.throws(()=>firebaseProject('zeus-automation-test',{...env,PRODUCTION_FIREBASE_PROJECT_ID:'zeus-automation-test'}));
 assert.throws(()=>firestoreDatabase({AUTOMATION_FIRESTORE_DATABASE:'(default)'}));
});
