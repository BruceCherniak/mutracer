#[cfg(test)]
mod parity_schedule_tests {
    use super::*;
    struct Controlled {
        entered: mpsc::Sender<CancelToken>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl super::super::CustomDenoiser for Controlled {
        fn denoise(&self,input:super::super::DenoiseInput,cancel:CancelToken)->std::result::Result<super::super::DenoiseOutput,String>{
            self.entered.send(cancel).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(super::super::DenoiseOutput::Cpu(input.color))
        }
    }
    #[test]
    #[ignore="real GPU schedule event table"]
    fn display_schedule_event_table() {
        let _guard=crate::ABI_TEST_LOCK.lock().unwrap_or_else(|e|e.into_inner());
        let table:serde_json::Value=serde_json::from_str(include_str!("../../../../tests/fixtures/display-schedule.json")).unwrap();
        for row in table["cases"].as_array().unwrap(){
            let (engine,render)=super::super::lifecycle_tests::fixture();
            engine.set_scene(&crate::api::tests::lit_scene()).unwrap();engine.update().unwrap();
            render.converge(ConvergeOptions::new(1)).unwrap();
            let (entered,receive)=mpsc::channel();let (release,resume)=mpsc::channel();
            render.set_custom_denoiser(Some(Arc::new(Controlled{entered,release:Mutex::new(resume)})),DenoiseSchedule::Progressive).unwrap();
            let mut actions=Vec::new();let mut token=CancelToken::new();
            for event in row["events"].as_array().unwrap(){
                match event.as_str().unwrap(){
                    "start"=>{
                        assert!(!render.denoise_current().unwrap());
                        token=receive.recv_timeout(Duration::from_secs(20)).unwrap();actions.push("Filter");
                        render.with(|s,id|{let r=&s.renders[&id];assert!(r.denoise.worker.is_some());assert_eq!(readiness(s,id).presentable,denoised_samples(r)>0);Ok(())}).unwrap();
                    },
                    "complete"=>{
                        release.send(()).unwrap();
                        if token.is_cancelled(){actions.push("Discard");}
                        else{
                            let start=Instant::now();
                            while !render.denoise_current().unwrap(){assert!(start.elapsed()<Duration::from_secs(20));std::thread::yield_now();}
                            actions.push("Publish");
                        }
                    },
                    "advance"=>{
                        render.with(|s,id|{let r=s.renders.get_mut(&id).unwrap();r.samples+=1;Ok(())}).unwrap();actions.push("Retain");
                    },
                    event=>{
                        render.with(|s,id|{let r=s.renders.get_mut(&id).unwrap();if event=="device-lost"{r.device_lost();}else{cancel_denoise(r);}Ok(())}).unwrap();
                        assert!(token.is_cancelled());actions.push("Cancel");
                    }
                }
            }
            assert_eq!(serde_json::json!(actions),row["actions"],"{}",row["name"]);
        }
    }
}
