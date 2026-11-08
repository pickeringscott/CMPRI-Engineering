import {profileHasRole} from './server/roles';
export const EMPLOYMENT_REVIEWER_ID = "750f77bf-7d5d-4ca6-8421-e025edea87ba";
type Identity={id:string;email?:string|null};
type Profile={role:unknown;secondary_roles?:readonly unknown[]};
export function employmentDepartments(identity:Identity,profile?:Profile):Array<'maintenance'|'front'>{
 const departments:Array<'maintenance'|'front'>=[];
 if(identity.id===EMPLOYMENT_REVIEWER_ID&&identity.email?.trim().toLowerCase()==='maint.cmpri@hawkeyehotels.com')departments.push('maintenance');
 if(profile&&(profileHasRole(profile,'front_desk_manager')||profileHasRole(profile,'assistant_manager')))departments.push('front');
 return departments;
}
export function canReviewEmployment(identity:Identity,profile?:Profile){return employmentDepartments(identity,profile).length>0;}
export function canReviewEmploymentDepartment(identity:Identity,profile:Profile,department:unknown){
 return employmentDepartments(identity,profile).includes((department??'maintenance') as 'maintenance'|'front');
}
