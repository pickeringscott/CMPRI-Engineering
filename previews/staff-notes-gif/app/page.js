'use client';
import {useEffect,useState} from 'react';
export default function Preview(){
 const [layout,setLayout]=useState(null);
 useEffect(()=>{const requested=new URLSearchParams(location.search).get('layout');setLayout(requested==='mobile'||requested==='desktop'?requested:matchMedia('(max-width:640px)').matches?'mobile':'desktop')},[]);
 return layout?<iframe className="source-preview" title="CMPRI Staff Notes preview" src={'/design/'+layout}/>:null;
}
