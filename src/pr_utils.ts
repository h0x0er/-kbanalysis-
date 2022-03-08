import {exec } from "child_process";
import * as core from "@actions/core";



function terminal(cmd:string){
    exec(cmd, async (error, stdout, stderr)=>{

        if(error){core.warning(`Error occurred: ${error}`)}
        if(stderr){core.warning(`Error occurred: ${stderr}`)}
        if(stdout){core.info(`Output: ${stdout}`)}


    })  
}


export async function createPR(client, content:String, path:String){
    terminal(`mkdir -p ${path}`)
    terminal(`touch ${path}/action-security.yml`)
    terminal(`ls ${path}`)
    terminal(`git remote origin --all`)

}