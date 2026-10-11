import test from 'node:test';
import assert from 'node:assert/strict';
import { troubleshootingStepAlreadyDone as done } from '../src/lib/troubleshooting-completed-steps.ts';
for(const [step,note] of [['Verify outlet','Outlet verified working; outlet check completed.'],['Check the breaker','Breaker is not tripped'],['Reset thermostat','Thermostat reset'],['Clean the air filter','Cleaned air filter'],['Replace bulb','Bulb already replaced'],['Reseat connection','Connection reseated']])test(`completed action: ${step}`,()=>assert.equal(done(step,note),true));
for(const note of ['Need to verify outlet','Outlet not yet checked','Check outlet','Outlet check not completed','Maybe outlet verified','Outlet was not checked','Outlet has not been verified'])test(`unfinished or uncertain action: ${note}`,()=>assert.equal(done('Verify outlet',note),false));
test('basic outlet check preserves deeper and different checks',()=>{
 for(const step of ['Measure outlet voltage','Inspect fixture socket and internal connection','Verify outlet under load','Recheck outlet after replacing breaker'])assert.equal(done(step,'Outlet verified working'),false);
});
test('multi-component steps require evidence for every component',()=>assert.equal(done('Verify outlet and wiring','Outlet verified working'),false));
test('questions and planned checks are not completed actions',()=>{
 for(const notes of ['Has outlet been verified?','Outlet to be checked','Outlet might have been checked'])assert.equal(done('Verify outlet',notes),false);
});
test('actions/root cause participate without requiring notes',()=>assert.equal(done('Replace bulb','',['Bulb replaced']),true));
test('explicitly ruled-out code suppresses only that code',()=>{
 assert.equal(done('Check code 1','Code 1 ruled out'),true);
 assert.equal(done('Check code 2','Code 1 ruled out'),false);
 assert.equal(done('Check code 1','Not code 1'),true);
 assert.equal(done('Check code 1','Code 1 not ruled out'),false);
 assert.equal(done('Check code 1 and 2','Code 1 ruled out'),false);
});
