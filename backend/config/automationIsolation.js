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
  if(!/^zeus[-_]automation[-_][a-z0-9_-]{1,40}$/.test(name))
    throw new Error('An isolated automation Firestore database is required');
  return name;
}
module.exports={mongoDatabase,firestoreDatabase};
