'use strict';
module.exports=function mongoOptions(dbName){return {
 dbName,
 // Two durable workers plus status/import requests; avoid a 100-socket pool per cold instance.
 maxPoolSize:10,minPoolSize:0,maxIdleTimeMS:60000,
 serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,waitQueueTimeoutMS:5000,
 socketTimeoutMS:15000,timeoutMS:15000,
};};
