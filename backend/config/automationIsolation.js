'use strict';
// Development branch guard: sharing credentials never implies sharing data stores.
function mongoDatabase(env=process.env) {
  const name=env.AUTOMATION_DB_NAME || 'zeus_automation_staging';
  if(!/^zeus_automation_[A-Za-z0-9_-]{1,48}$/.test(name))
    throw new Error('An isolated zeus_automation_ MongoDB database is required');
  return name;
}
function firestoreDatabase(env=process.env) {
  const name=env.AUTOMATION_FIRESTORE_DATABASE || 'zeus-automation-staging';
  const independentDefault=name==='(default)' && /^zeus[-_]automation[-_][a-z0-9_-]+$/.test(env.AUTOMATION_FIREBASE_PROJECT_ID||'') && env.AUTOMATION_FIREBASE_PROJECT_ID!==env.PRODUCTION_FIREBASE_PROJECT_ID;
  if(!independentDefault && !/^zeus[-_]automation[-_][a-z0-9_-]{1,40}$/.test(name))
    throw new Error('An isolated automation Firestore database is required');
  return name;
}
function firebaseProject(actualProjectId,env=process.env){
 const expected=env.AUTOMATION_FIREBASE_PROJECT_ID;
 if(!expected||actualProjectId!==expected||expected===env.PRODUCTION_FIREBASE_PROJECT_ID)throw new Error('Isolated Firebase project identity mismatch');
 firestoreDatabase(env);return expected;
}
module.exports={mongoDatabase,firestoreDatabase,firebaseProject};
