'use strict';
// A cold-start/reconnect attempt is shared by concurrent HTTP requests.
// Never cache a previously connected instance after its socket disconnected.
module.exports = function createConnector(mongoose, {uri, dbName}) {
  let connecting;
  return async function connect() {
    if(!uri)return null;
    if(mongoose.connection.readyState===1)return mongoose;
    if(!connecting) {
      connecting=mongoose.connect(uri,{dbName,serverSelectionTimeoutMS:5000})
        .finally(()=>{connecting=undefined;});
    }
    return connecting;
  };
};
