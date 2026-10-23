/** Import semantics gate. Preserve source columns; never guess a SKU from prose or a URL. */
export function poImportFieldIssue(line:{description:string;sku:string}):string|null {
 const description=line.description.trim(),sku=line.sku.trim();
 if(!description)return 'Product description is missing.';
 if(/^https?:\/\//i.test(description))return 'Source Description contains a URL. Review product name, product URL and actual SKU separately before import; source Item # is not proof of a SKU.';
 if(/^https?:\/\//i.test(sku))return 'Source item identifier contains a URL; verify the actual SKU before import.';
 return null;
}

export type SourceProductFields={sourceFormat:'ibuy-offline'|'supplier-table';itemNumber:string;description:string};
export type NormalizedProductFields={description:string|null;productUrl:string|null;supplierSku:string|null;source:SourceProductFields;reviewRequired:boolean;reason:string|null};
/** The reviewed iBuy Offline convention puts product prose in Item # and URL in Description.
 * Raw extraction stays immutable. Numeric/compact identifiers are never renamed as products.
 * These canonical fields must not be persisted by the legacy SKU-keyed storage contract.
 */
export function normalizePoProductFields(input:SourceProductFields):NormalizedProductFields {
 const source={...input},item=input.itemNumber.trim(),description=input.description.trim();
 const result:NormalizedProductFields={description:description||null,productUrl:null,supplierSku:item||null,source,reviewRequired:false,reason:null};
 if(/^https?:\/\//i.test(item))return {...result,reviewRequired:true,reason:'Source item identifier contains a URL; verify the actual product fields before import.'};
 if(!/^https?:\/\//i.test(description))return {...result,reviewRequired:!description,reason:description?null:'Product description is missing.'};
 let url:URL;
 try{url=new URL(description);}catch{return {...result,description:null,reviewRequired:true,reason:'Malformed source product URL.'};}
 if(url.protocol!=='https:'||url.username||url.password||url.port||/\s/.test(description))return {...result,description:null,reviewRequired:true,reason:'Product URL requires source review.'};
 const prose=/[A-Za-z]{2}/.test(item)&&/\s/.test(item)&&!/^https?:/i.test(item);
 if(input.sourceFormat!=='ibuy-offline'||!prose)return {...result,description:null,productUrl:description,reviewRequired:true,reason:'Actual product name is not established by this source format.'};
 return {...result,description:item,productUrl:description,supplierSku:null};
}
