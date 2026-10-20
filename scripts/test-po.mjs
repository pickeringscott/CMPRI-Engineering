import {spawnSync} from 'node:child_process';
const cases=[
 'tests/drive-po-push.test.mjs',
 'tests/po-offline-pdf.test.mjs',
 'tests/po-offline-recovery.test.mjs',
 'tests/po-presentation.test.mjs','tests/po-spending.test.mjs','tests/po-mounted.test.mjs',
 'tests/po-selection.test.mjs','tests/po-workflow.test.mjs','tests/po-identity-import.test.mjs',
 'tests/po-receiving.test.mjs','tests/po-cancellation.test.mjs','tests/po-catchup.test.mjs',
 'tests/po-database.test.mjs','tests/po-source-parser.test.mjs','tests/po-supplier-intake.test.mjs',
 'tests/po-attachment-intake.test.mjs','tests/po-mailbox-batch.test.mjs',
 'tests/purchasing-history.test.mjs','tests/purchasing-history-route.test.mjs',
 'tests/po-pdf.test.mjs','tests/plain-text-links.test.mjs'
];
for(const file of cases){
 const result=spawnSync(process.execPath,['--import','./tests/helpers/resolve-ts.mjs',file],{stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
console.log(`PASS all ${cases.length} portable PO test commands`);
