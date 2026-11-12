'use strict';
const DEFAULT_OPERATION = Object.freeze({ mode: 'learning', allowHardwareWrites: false });
function resolveOperation(input) {
  const mode=input?.mode==='learning'?'learning':'learning';
  return { mode, allowHardwareWrites:false, label:'Inlärningsläge – endast läsning och simulering' };
}
function assertReadOnly() { throw new Error('Hardware writes are disabled in this build'); }
module.exports={DEFAULT_OPERATION,resolveOperation,assertReadOnly};
